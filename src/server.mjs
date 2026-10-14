import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { LeapClient } from './leap-client.mjs';
import { Store, normalize } from './store.mjs';
import { ProtocolError } from './protocol.mjs';
import { PairingGate } from './pairing.mjs';
import { readSessionFile } from './session-file.mjs';
import { readAuthHealth, recordRenewal, recordPoll, resetAuthHealth } from './auth-health.mjs';
import { readDiagnostics } from './read-diagnostics.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const port = Number(process.env.PORT || 8080);
const adminPassword = process.env.ADMIN_PASSWORD || '';
if (adminPassword.length < 12 || adminPassword.includes('CHANGE_ME')) throw new Error('Set a unique ADMIN_PASSWORD of at least 12 characters');
const data = new Store(process.env.DATA_DIR || join(root, 'data'));
data.recoverCommands();
const passwordSalt = randomBytes(16);
const passwordDigest = scryptSync(adminPassword, passwordSalt, 64);
const sessions = new Map();
const attempts = new Map();
const pairing = new PairingGate();
const pairingUrl = process.env.PAIR_BASE_URL || '';
if (pairingUrl && (!/^https:\/\/[^/?#]+\/?$/.test(pairingUrl) || new URL(pairingUrl).username)) {
  throw new Error('PAIR_BASE_URL must be an HTTPS origin without a path');
}
let busy = false;
let commandBusy = false;
let lastError = null;
let addressCache = { coordinates: '', address: null, checkedAt: 0 };
const allowControl = process.env.ALLOW_CONTROL === 'true';
const requestedInterval = Number(process.env.POLL_MINUTES || 5);
const intervalMinutes = Number.isFinite(requestedInterval) ? Math.max(3, Math.min(30, requestedInterval)) : 5;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function addressFor(position) {
  if (!position || !process.env.AMAP_WEB_KEY) return null;
  const coordinates = `${position.longitude.toFixed(5)},${position.latitude.toFixed(5)}`;
  if (addressCache.coordinates === coordinates && Date.now() - addressCache.checkedAt < 60 * 60_000) return addressCache.address;
  const url = new URL('https://restapi.amap.com/v3/geocode/regeo');
  url.search = new URLSearchParams({ key: process.env.AMAP_WEB_KEY, location: coordinates,
    extensions: 'base', output: 'JSON' }).toString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) return null;
    const result = await response.json();
    const address = result.status === '1' && typeof result.regeocode?.formatted_address === 'string'
      ? result.regeocode.formatted_address.slice(0, 160) : null;
    addressCache = { coordinates, address, checkedAt: Date.now() };
    return address;
  } catch { return null; }
}
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value));
};
const fail = (res, error, status = 400) => {
  const message = error instanceof ProtocolError ? error.message : '服务器内部错误';
  json(res, status, { error: message, code: error.code || 'ERROR' });
};
async function body(req) {
  let content = '';
  for await (const chunk of req) {
    content += chunk;
    if (content.length > 32_000) throw new ProtocolError('请求内容过大');
  }
  try { return JSON.parse(content || '{}'); } catch { throw new ProtocolError('请求 JSON 格式错误'); }
}
function cookie(req) {
  const pairs = (req.headers.cookie || '').split(';').map(s => s.trim().split('='));
  const raw = pairs.find(p => p[0] === 'harbor_session')?.[1];
  return raw && sessions.get(raw)?.expires > Date.now() ? raw : null;
}
function protectedRoute(req, res) {
  const token = cookie(req);
  if (!token) { json(res, 401, { error: '请登录玄关服务' }); return false; }
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    // Browser requests must originate from this exact host; no CORS is granted.
    if (!origin || new URL(origin).host !== req.headers.host || req.headers['x-harbor-csrf'] !== token) {
      json(res, 403, { error: '请求来源校验失败' }); return false;
    }
  }
  sessions.get(token).expires = Date.now() + 12 * 3600_000;
  return true;
}
async function refresh() {
  if (busy || commandBusy || !data.session()) return false;
  busy = true;
  try {
    const client = connectedClient();
    const raw = await client.status();
    data.saveSession(client.s);
    const previous = data.latest();
    const incoming = normalize(raw);
    const saved = data.addSample(incoming);
    const now = Date.now();
    recordPoll(data, true, now, readDiagnostics(raw, incoming, previous, saved, now));
    lastError = null;
    return saved;
  } catch (error) {
    recordPoll(data, false);
    lastError = error instanceof ProtocolError ? error.message : '车况读取失败';
    return false;
  } finally { busy = false; }
}
function connectedClient() {
  return new LeapClient(data.session(), fetch, {
    onSessionChange: session => data.saveSession(session),
    onRenewal: event => recordRenewal(data, event),
  });
}
const recent = () => ({ connected: Boolean(data.session()),
  vehicle: data.session()?.name || null,
  status: data.latest(),
  statusAgeMinutes: data.latest() ? Math.round((Date.now() - data.latest().receivedAt) / 60000) : null,
  lastError, controlEnabled: allowControl, lastCommand: data.recentCommand(),
  sampling: busy, activeTrip: JSON.parse(data.setting('activeTrip', 'null')) !== null,
  version: appVersion, revision: process.env.APP_REVISION || null,
  authHealth: { ...readAuthHealth(data), gatewayExpiresAt: data.session()?.gateway?.expiresAt ?? null,
    oldExpiresAt: data.session()?.old?.expiresAt ?? null } });

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://local').pathname;
    if (path === '/health') return json(res, 200, { ok: true, version: appVersion });
    if (staticFiles[path] && req.method === 'GET') {
      const [name, type] = staticFiles[path];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'" });
      return res.end(readFileSync(join(root, 'public', name)));
    }
    if (path === '/api/login' && req.method === 'POST') {
      const remote = req.socket.remoteAddress || 'unknown';
      const state = attempts.get(remote) || { count: 0, until: 0 };
      if (state.until > Date.now()) return json(res, 429, { error: '登录尝试过多，请稍后重试' });
      const input = await body(req);
      const candidate = scryptSync(String(input.password || '').slice(0, 512), passwordSalt, 64);
      if (!timingSafeEqual(candidate, passwordDigest)) {
        state.count++;
        if (state.count >= 5) { state.until = Date.now() + 15 * 60_000; state.count = 0; }
        attempts.set(remote, state);
        return json(res, 401, { error: '密码错误' });
      }
      attempts.delete(remote);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { expires: Date.now() + 12 * 3600_000 });
      res.setHeader('Set-Cookie', `harbor_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${pairingUrl ? '; Secure' : ''}`);
      return json(res, 200, { ok: true, csrf: token });
    }
    if (path === '/api/pair/complete' && req.method === 'POST') {
      if (!pairingUrl) return json(res, 403, { error: '手机配对未启用，请先配置 HTTPS 的 PAIR_BASE_URL' });
      if (req.headers.host !== new URL(pairingUrl).host) return json(res, 403, { error: '请通过配置的 HTTPS 地址配对' });
      const input = await body(req);
      if (!pairing.claim(input.code)) return json(res, 403, { error: '配对码无效、过期或尝试次数过多' });
      try {
        const client = new LeapClient();
        await client.importSession(input.session);
        data.saveSession(client.s); data.set('deviceId', client.s.deviceId); resetAuthHealth(data);
        pairing.finish(true);
        void refresh();
        return json(res, 200, { ok: true, vehicle: client.s.name });
      } catch (error) {
        pairing.finish(false);
        throw error;
      }
    }
    if (path.startsWith('/api/')) {
      if (!protectedRoute(req, res)) return;
      if (path === '/api/session' && req.method === 'GET') return json(res, 200, { csrf: cookie(req) });
      if (path === '/api/state' && req.method === 'GET') return json(res, 200, recent());
      if (path === '/api/pair/start' && req.method === 'POST') {
        if (!pairingUrl) return json(res, 403, { error: '请先为 NAS 配置有效 HTTPS 域名和 PAIR_BASE_URL' });
        if (new URL(req.headers.origin).protocol !== 'https:') return json(res, 403, { error: '请通过 HTTPS 打开 NAS 页面再生成配对码' });
        return json(res, 200, { url: pairingUrl.replace(/\/$/, ''), ...pairing.start() });
      }
      if (path === '/api/pair/status' && req.method === 'GET') return json(res, 200, pairing.status());
      if (path === '/api/address' && req.method === 'GET') {
        const current = data.latest();
        return json(res, 200, { address: await addressFor(current?.position), sourceTime: current?.sourceTime || null });
      }
      if (path === '/api/trips' && req.method === 'GET') return json(res, 200, { trips: data.trips(), days: data.days() });
      if (path === '/api/logout' && req.method === 'POST') {
        sessions.delete(cookie(req)); res.setHeader('Set-Cookie', 'harbor_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(res, 200, { ok: true });
      }
      if (path === '/api/vehicle/disconnect' && req.method === 'POST') {
        data.clearSession(); resetAuthHealth(data); lastError = null; return json(res, 200, { ok: true });
      }
      if (path === '/api/vehicle/sms' && req.method === 'POST') {
        const input = await body(req);
        const client = new LeapClient({ deviceId: data.setting('deviceId', randomBytes(16).toString('hex')) });
        await client.sms(String(input.phone || ''));
        data.set('deviceId', client.s.deviceId);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/vehicle/login' && req.method === 'POST') {
        const input = await body(req);
        const client = new LeapClient({ deviceId: data.setting('deviceId', randomBytes(16).toString('hex')) });
        await client.login(String(input.phone || ''), String(input.smsCode || ''), String(input.smDeviceId || ''));
        data.saveSession(client.s); data.set('deviceId', client.s.deviceId); resetAuthHealth(data);
        await refresh(); return json(res, 200, recent());
      }
      if (path === '/api/vehicle/import' && req.method === 'POST') {
        const input = await body(req);
        const client = new LeapClient();
        await client.importSession(input);
        data.saveSession(client.s); data.set('deviceId', client.s.deviceId); resetAuthHealth(data);
        await refresh(); return json(res, 200, recent());
      }
      if (path === '/api/vehicle/import-file' && req.method === 'POST') {
        const input = readSessionFile(process.env.SESSION_IMPORT_FILE || '/import/c11-nas-session.json');
        const client = new LeapClient();
        await client.importSession(input);
        data.saveSession(client.s); data.set('deviceId', client.s.deviceId); resetAuthHealth(data);
        await refresh(); return json(res, 200, recent());
      }
      if (path === '/api/refresh' && req.method === 'POST') {
        await refresh(); return json(res, 200, recent());
      }
      if (path === '/api/climate' && req.method === 'POST') {
        if (!allowControl) return json(res, 403, { error: '控制功能未启用；设置 ALLOW_CONTROL=true 后重启服务' });
        if (!data.session()) return json(res, 400, { error: '尚未接入车辆' });
        if (commandBusy) return json(res, 409, { error: '已有控制正在执行' });
        const input = await body(req);
        if (input.confirm !== '执行空调指令') return json(res, 400, { error: '请先确认本次空调操作' });
        const action = input.action;
        const temperature = Number(input.temperature);
        const pin = String(input.pin || '');
        if (!['on', 'off'].includes(action) || !/^\d{4}$/.test(pin)) return json(res, 400, { error: '空调操作或四位密码无效' });
        if (action === 'on' && (!Number.isInteger(temperature) || temperature < 16 || temperature > 32)) return json(res, 400, { error: '温度需为 16 至 32 的整数' });
        const id = randomBytes(12).toString('hex');
        commandBusy = true;
        data.command(id, action, '处理中', '指令发送中');
        // Return task id now; keep PIN only in the current closure and never store it.
        json(res, 202, { id });
        (async () => {
          try {
            const client = connectedClient();
            const msgID = await client.climate(action, action === 'on' ? temperature : 24, pin);
            data.saveSession(client.s);
            if (!msgID) {
              data.updateCommand(id, '待确认', '云端已接收，但未返回结果编号；请查看车况'); return;
            }
            for (let i = 0; i < 30; i++) {
              await sleep(i ? 500 : 1000);
              const response = await client.pollControl(msgID);
              const code = response.result ?? response.code;
              if (String(code) === '0') {
                data.updateCommand(id, '已执行', '车端返回执行成功');
                await refreshAfterCommand(client); return;
              }
              if (code !== undefined && !['1', '2', '100', '202'].includes(String(code))) {
                data.updateCommand(id, '失败', `车端返回码 ${String(code).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}`); return;
              }
            }
            data.updateCommand(id, '待确认', '等待车辆执行结果超时，请查看实际车况');
          } catch {
            data.updateCommand(id, '待确认', '网络或会话异常，指令结果未知；请检查车辆状态');
          } finally { commandBusy = false; }
        })();
        return;
      }
      if (path.startsWith('/api/commands/') && req.method === 'GET') {
        const id = path.slice('/api/commands/'.length);
        if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 404, { error: '任务不存在' });
        return json(res, 200, data.getCommand(id) || { error: '任务不存在' });
      }
    }
    json(res, 404, { error: '未找到' });
  } catch (error) { fail(res, error, error.code === 'AUTH' ? 401 : 400); }
});
async function refreshAfterCommand(client) {
  try {
    const raw = await client.status(); data.saveSession(client.s); data.addSample(normalize(raw));
  } catch { /* Poll result is still preserved; next scheduled refresh retries. */ }
}
let timer;
export function start() {
  server.listen(port, '0.0.0.0', () => console.log(`C11 Harbor listening on ${port}`));
  timer = setInterval(() => { void refresh(); data.prune(); }, intervalMinutes * 60_000);
  timer.unref();
  setTimeout(() => { void refresh(); }, 1000).unref();
  return server;
}
if (process.env.NODE_ENV !== 'test') start();
export { server };
