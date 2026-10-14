import { randomBytes } from 'node:crypto';
import { GLOBAL, USER, ProtocolError, gatewayHeaders, oldHeaders, oldParams, encryptPhone, encryptPin, deriveKey, jwtPayload, trustedHost, findObject } from './protocol.mjs';

const ok = value => ['0', '200'].includes(String(value));
export class LeapClient {
  constructor(session = {}, fetcher = fetch, { onSessionChange = () => {}, onRenewal = () => {} } = {}) {
    this.s = { deviceId: randomBytes(16).toString('hex'), appVersion: '1.22.95', ...session };
    this.fetcher = fetcher;
    this.onSessionChange = onSessionChange;
    this.onRenewal = onRenewal;
  }
  checkpoint() {
    try { this.onSessionChange(this.s); }
    catch { throw new ProtocolError('会话保存失败，请检查 NAS 数据卷', 'STORAGE'); }
  }
  renewal(kind, ok, error = null) {
    this.onRenewal({ kind, ok, at: Date.now(), code: ok ? null :
      ['AUTH', 'NETWORK', 'BUSINESS', 'STORAGE'].includes(error?.code) ? error.code : 'ERROR' });
  }
  async request(host, path, { method = 'GET', headers = {}, query, json, form, check = true } = {}) {
    const url = new URL(path, trustedHost(host));
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.fetcher(url, { method, headers: { ...headers,
        ...(json ? { 'Content-Type': 'application/json' } : form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : method === 'POST' ? '' : undefined,
        signal: AbortSignal.timeout(15000), redirect: 'error' });
    } catch { throw new ProtocolError('零跑接口连接失败或超时', 'NETWORK'); }
    if (!response.ok) throw new ProtocolError(`零跑接口 HTTP ${response.status}`, [401, 403].includes(response.status) ? 'AUTH' : 'NETWORK');
    // Read a bounded body, never put raw responses or URLs into errors/logs.
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2_000_000) { await reader.cancel(); throw new ProtocolError('零跑响应过大'); }
      chunks.push(Buffer.from(value));
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new ProtocolError('零跑接口未返回有效 JSON'); }
    const code = data.result ?? data.code;
    if (check && code !== undefined && !ok(code)) {
      if (['39', '401', '403'].includes(String(code))) throw new ProtocolError('车辆登录已失效，请重新接入', 'AUTH');
      throw new ProtocolError(`零跑业务返回码 ${String(code).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}；请检查客户端兼容性或风控验证`, 'BUSINESS');
    }
    return data;
  }
  async sms(phone) {
    if (!/^1\d{10}$/.test(phone)) throw new ProtocolError('请输入 11 位手机号');
    return this.request(USER, '/app-user/applogin/compliance/sendmessagecode', {
      headers: oldHeaders(this.s), query: { phoneNo: encryptPhone(phone) } });
  }
  async login(phone, smsCode, smDeviceId) {
    if (!/^1\d{10}$/.test(phone) || !/^\d{4,8}$/.test(smsCode)) throw new ProtocolError('手机号或验证码格式不正确');
    if (typeof smDeviceId !== 'string' || !smDeviceId.trim()) throw new ProtocolError('需要有效的数美 smDeviceId；第一版不生成设备指纹，可使用已有会话导入');
    const response = await this.request(USER, '/app-user/applogin/check_login_with_phone', { method: 'POST', check: false,
      headers: oldHeaders(this.s), query: { phoneNoCiphertext: encryptPhone(phone), smsCode, deviceID: this.s.deviceId,
        smDeviceId: smDeviceId.trim(), os: 'android', pageUrl: '' } });
    if (findObject(response, o => o.risk_type)) throw new ProtocolError('零跑要求极验验证；第一版未集成该验证，请通过安卓客户端完成登录后导入会话', 'CAPTCHA');
    const auth = findObject(response, o => o.accountId && o.token);
    if (!auth || (response.result !== undefined && !ok(response.result)) || (response.code !== undefined && !ok(response.code))) throw new ProtocolError('短信登录未成功，请检查验证码或风控参数');
    this.s.phone = phone;
    this.s.old = { accountId: String(auth.accountId), token: auth.token, refreshToken: auth.refreshToken || '',
      expiresAt: Date.now() + (Number(auth.tokenExpired) || 21600) * 1000 };
    await this.exchange();
    return this.connect();
  }
  acceptGateway(response) {
    const data = findObject(response, o => o.accessToken && o.signParam);
    if (!data) throw new ProtocolError('网关响应缺少令牌和签名参数');
    const payload = jwtPayload(data.accessToken);
    const bound = /deviceId:([a-zA-Z0-9_-]+)/.exec(payload.user_name || '');
    if (bound) this.s.deviceId = bound[1];
    this.s.gateway = { accountId: this.s.old.accountId, accessToken: data.accessToken,
      refreshToken: data.refreshToken || '', signKeyBase64: deriveKey(data.accessToken, data.signParam.r2, data.signParam.r3).toString('base64'),
      expiresAt: payload.exp ? payload.exp * 1000 : Date.now() + (Number(data.tokenExpireTime) || 3600) * 1000 };
    this.checkpoint();
  }
  async exchange() {
    const body = { identifier: this.s.old.accountId, identifierType: '1', security: this.s.old.token };
    this.acceptGateway(await this.request(GLOBAL, '/base/base-user/account/v1/login', {
      method: 'POST', json: body, headers: gatewayHeaders(this.s, body, false) }));
  }
  async refreshOld() {
    try {
    if (!this.s.phone || !this.s.old?.refreshToken) throw new ProtocolError('缺少旧会话续期信息，请重新接入', 'AUTH');
    const params = oldParams(this.s, { accountId: this.s.old.accountId, accountNumber: encryptPhone(this.s.phone) }, true);
    const response = await this.request(USER, '/app-user/appuseroperate/getnewtoken', { query: params,
      headers: { ...oldHeaders(this.s), 'XFX-CDN-CROSS-REFRESH-NODE': this.s.old.refreshToken } });
    const data = findObject(response, o => o.token);
    if (!data) throw new ProtocolError('旧会话续期未返回令牌', 'AUTH');
    this.s.old = { ...this.s.old, token: data.token, refreshToken: data.refreshToken || this.s.old.refreshToken,
      expiresAt: Date.now() + (Number(data.tokenExpired) || 21600) * 1000 };
    this.checkpoint();
    await this.exchange();
    this.renewal('legacy', true);
    } catch (error) { this.renewal('legacy', false, error); throw error; }
  }
  async refreshGateway() {
    try {
      const body = { refreshToken: this.s.gateway.refreshToken };
      this.acceptGateway(await this.request(GLOBAL, '/base/base-user/token/v1/refresh', {
        method: 'POST', json: body, headers: gatewayHeaders(this.s, body) }));
      this.renewal('gateway', true);
    } catch (error) {
      this.renewal('gateway', false, error);
      if (error.code === 'STORAGE') throw error;
      await this.refreshOld();
    }
  }
  async gateway(host, path, method = 'GET', params = {}) {
    if (!this.s.gateway) throw new ProtocolError('尚未接入车辆', 'AUTH');
    if (this.s.gateway.expiresAt <= Date.now() + 120000) await this.refreshGateway();
    const call = () => this.request(host, path, { method, headers: gatewayHeaders(this.s, params),
      ...(method === 'GET' ? { query: params } : { json: params }) });
    try { return await call(); } catch (error) {
      if (error.code !== 'AUTH') throw error;
      await this.refreshGateway(); return call();
    }
  }
  async importSession(input) {
    if (!input || !input.old || typeof input.old.accountId !== 'string' || typeof input.old.token !== 'string' ||
      !input.old.accountId || input.old.token.length < 16 || typeof input.deviceId !== 'string' || !/^[\w-]{8,128}$/.test(input.deviceId)) {
      throw new ProtocolError('需要 deviceId 和 old.accountId / old.token，请参考接入说明');
    }
    if (input.phone && !/^1\d{10}$/.test(input.phone)) throw new ProtocolError('导入手机号无效');
    this.s = { deviceId: input.deviceId, appVersion: String(input.appVersion || '1.22.95').slice(0, 32),
      subVersion: String(input.subVersion || '').slice(0, 64), phone: input.phone || '',
      old: { accountId: input.old.accountId, token: input.old.token, refreshToken: input.old.refreshToken || '',
        expiresAt: Number(input.old.expiresAt) || Date.now() + 300000 } };
    // Always exchange with the gateway; do not trust an imported signKey or route.
    await this.exchange(); return this.connect();
  }
  async connect() {
    const response = await this.gateway(GLOBAL, '/app/app-global-service/v1/vehicle/list');
    const vehicles = [];
    const collect = obj => {
      if (!obj || typeof obj !== 'object') return;
      if (typeof obj.vin === 'string' && obj.vin.length >= 8) {
        if (!vehicles.some(v => v.vin === obj.vin)) vehicles.push({ vin: obj.vin, carType: obj.carType || obj.cartype || obj.modelParam?.carType || obj.model || '',
          name: obj.vehicleName || obj.carName || obj.nickName || '我的 C11' });
      }
      Object.values(obj).forEach(collect);
    };
    collect(response);
    if (!vehicles.length) throw new ProtocolError('账号未返回车辆');
    this.s.vehicles = vehicles;
    // Single vehicle V1: fail visibly instead of controlling an arbitrary car.
    if (vehicles.length !== 1) throw new ProtocolError('第一版仅支持单车账号；检测到多辆车，未自动选择');
    this.s.vin = vehicles[0].vin; this.s.carType = vehicles[0].carType; this.s.name = vehicles[0].name;
    const route = await this.gateway(GLOBAL, '/app/app-global-service/v1/vehicle/getCarRoute', 'GET', { vin: this.s.vin });
    const data = findObject(route, o => o.appRegion);
    if (!data) throw new ProtocolError('车辆路由缺少 appRegion');
    this.s.appRegion = trustedHost(data.appRegion);
    return this.s;
  }
  async status() {
    const response = await this.gateway(this.s.appRegion, '/app/app-signal-service/signal/info/query', 'POST', { vin: this.s.vin });
    const data = findObject(response, o => o.signalMap && typeof o.signalMap === 'object');
    if (!data || !Object.keys(data.signalMap).length) throw new ProtocolError('车况响应未返回 signalMap');
    return { ...data.signalMap, sts: data.signalMap.sts ?? data.sts ?? response.data?.sts,
      _timestampCandidates: { signalMap: data.signalMap.sts, envelope: data.sts,
        outerData: response.data?.sts, outer: response.sts } };
  }
  async climate(action, temperature, pin) {
    if (!/^\d{4}$/.test(pin)) throw new ProtocolError('需要四位操作密码');
    if (!['on', 'off'].includes(action) || !Number.isInteger(temperature) || temperature < 16 || temperature > 32) throw new ProtocolError('空调参数无效');
    if (this.s.old.expiresAt <= Date.now() + 120000) await this.refreshOld();
    if (this.s.gateway.expiresAt <= Date.now() + 120000) await this.refreshGateway();
    const state = action === 'off'
      ? { operate: 'off', temperature: '24', windlevel: '3', mode: 'nohotcold', circle: 'in', wshld: '1', position: 'all' }
      : { operate: 'manual', temperature: String(temperature), windlevel: '7', mode: temperature <= 26 ? 'cold' : 'hot', circle: 'in', wshld: '0', position: 'all' };
    const form = oldParams(this.s, { cmdid: '170', state: JSON.stringify(state), carvin: this.s.vin,
      oppwd: encryptPin(pin, this.s.gateway.accessToken || this.s.old.token) });
    // POST is sent once. Never replay a control on timeout or route fallback.
    const response = await this.request(this.s.appRegion, '/app/app-control-service/v3/api/appremotectl', {
      method: 'POST', form, headers: { ...oldHeaders(this.s), ...gatewayHeaders(this.s, form) } });
    const object = findObject(response, o => o.msgID || o.msgId || o.eventId);
    return object?.msgID || object?.msgId || object?.eventId || (typeof response.data === 'string' ? response.data : '');
  }
  async pollControl(msgID) {
    const params = oldParams(this.s, { msgID: String(msgID) });
    return this.request(this.s.appRegion, '/app/app-control-service/v3/api/appremotectl/query', {
      query: params, check: false, headers: { ...oldHeaders(this.s), ...gatewayHeaders(this.s, params) } });
  }
}
