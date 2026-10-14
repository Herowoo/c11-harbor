import { createHash, createHmac, randomInt, publicEncrypt, createCipheriv, constants } from 'node:crypto';

// Independently implemented from protocol facts. No APK/SDK binary is bundled.
const PHONE_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDHUIQKhkwNqJFTZPe98mC1lmpbY9r/+7PEWZg8ebqYXT3sumKRaQ0zcoTx42x0iybmCRXy4CcZrgGAbwKzwqwNw0rFquJ6c7mgQA6k3lZU3p96qBlzK7DSkoFR6mO9pjcd2hlJ8wH+IwI5b8IWWZhwVN/4cM7npG0S0zeRn3soEwIDAQAB';
export const GLOBAL = 'https://app-gw-global-master.leapmotor.com';
export const USER = 'https://appuser.leapmotor.cn';
export class ProtocolError extends Error {
  constructor(message, code = 'PROTOCOL') { super(message); this.code = code; }
}
export const concatenate = (...maps) => Object.entries(Object.assign({}, ...maps))
  .filter(([, value]) => value !== null && value !== undefined)
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => String(value)).join('');
export const md5short = value => createHash('md5').update(value).digest('hex').slice(8, 24);
export function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); } catch { return {}; }
}
export function deriveKey(token, r2, r3) {
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new ProtocolError('网关令牌格式无效');
  const parts = [Buffer.from(token.split('.')[2], 'base64url'), Buffer.from(r2 || '', 'base64'), Buffer.from(r3 || '', 'base64')];
  const length = Math.min(...parts.map(p => p.length));
  if (!length) throw new ProtocolError('网关签名参数不完整');
  return Buffer.from(Array.from({ length }, (_, i) => parts[0][i] ^ parts[1][i] ^ parts[2][i]));
}
export function gatewayHeaders(session, params = {}, authenticated = true, now = Date.now(), nonce = String(randomInt(10000, 10010000))) {
  const signed = { acceptLanguage: 'zh-CN', channel: '1', deviceId: session.deviceId,
    deviceType: 'android', nonce, source: 'leapmotor', timestamp: String(now), version: session.appVersion || '1.22.95' };
  const input = concatenate(signed, params);
  const sign = authenticated
    ? createHmac('sha256', Buffer.from(session.gateway.signKeyBase64, 'base64')).update(input).digest('hex')
    : createHash('sha256').update(input).digest('hex');
  return { ...signed, sign, 'x-region': 'CN', 'x-api-signature-version': '2.0', digest: '',
    'x-subversion': session.subVersion || '', userId: session.old?.accountId || session.gateway?.accountId || '',
    carvin: session.vin || '', cartype: session.carType || '', ...(authenticated ? { token: session.gateway.accessToken } : {}) };
}
export function oldHeaders(session) {
  return { 'User-Agent': 'okhttp/4.9.3', APPPlatform: 'Android', APPVersion: session.appVersion || '1.22.95',
    APPImei: session.deviceId, 'C-VERSIONS': 'APP', 'XFX-CDN-VRS': 'v4',
    ...(session.old ? { 'XFX-CDN-CROSS-NODE': session.old.token } : {}) };
}
export function oldParams(session, business = {}, refresh = false, now = Date.now(), nonce = String(randomInt(10000, 10010000))) {
  const authKey = refresh ? 'refreshtoken' : 'token';
  const params = { timespan: String(now), nonce, deviceID: session.deviceId,
    [authKey]: refresh ? session.old.refreshToken : session.old.token, ...business };
  const signStr = md5short(concatenate(params));
  delete params[authKey];
  return { ...params, signStr };
}
export function encryptPhone(phone) {
  return publicEncrypt({ key: Buffer.from(PHONE_KEY, 'base64'), format: 'der', type: 'spki',
    padding: constants.RSA_PKCS1_PADDING }, Buffer.from(phone)).toString('base64url');
}
export function encryptPin(pin, token) {
  const effective = token.length >= 32 && token.length < 64 ? token + token : token;
  if (effective.length < 64) throw new ProtocolError('令牌长度不足，无法生成操作密码');
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(md5short(effective.slice(0, 32))), Buffer.from(md5short(effective.slice(32, 64))));
  return Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]).toString('base64');
}
export function trustedHost(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
      !['leapmotor.com', 'leapmotor.cn'].some(d => u.hostname === d || u.hostname.endsWith('.' + d))) {
    throw new ProtocolError('车辆路由不在零跑 HTTPS 域名范围内');
  }
  return u.origin;
}
export function findObject(root, predicate) {
  if (!root || typeof root !== 'object') return null;
  if (!Array.isArray(root) && predicate(root)) return root;
  for (const child of Object.values(root)) { const found = findObject(child, predicate); if (found) return found; }
  return null;
}
