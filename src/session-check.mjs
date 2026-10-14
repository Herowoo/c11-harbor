import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LeapClient } from './leap-client.mjs';
import { GLOBAL, USER, ProtocolError, gatewayHeaders, trustedHost } from './protocol.mjs';

// This diagnostic cannot send SMS or vehicle commands, even by accidental reuse.
const endpoints = new Map([
  ['/base/base-user/account/v1/login', ['POST', GLOBAL]],
  ['/base/base-user/token/v1/refresh', ['POST', GLOBAL]],
  ['/app-user/appuseroperate/getnewtoken', ['GET', USER]],
  ['/app/app-global-service/v1/vehicle/list', ['GET', GLOBAL]],
  ['/app/app-global-service/v1/vehicle/getCarRoute', ['GET', GLOBAL]],
  ['/app/app-signal-service/signal/info/query', ['POST', null]],
]);

export function diagnosticFetch(fetcher = fetch, audit = []) {
  return async (url, init = {}) => {
    const target = new URL(url);
    const rule = endpoints.get(target.pathname);
    const method = init.method || 'GET';
    if (!rule || method !== rule[0] || (rule[1] && target.origin !== new URL(rule[1]).origin)) {
      throw new ProtocolError('验证脚本拒绝非验证用途的请求', 'SCOPE');
    }
    trustedHost(target.origin);
    audit.push(target.pathname);
    return fetcher(url, init);
  };
}

export async function checkSession(client, mode, persist, input) {
  if (!['import', 'probe', 'refresh-gateway', 'refresh-old'].includes(mode)) {
    throw new ProtocolError('验证模式无效', 'INPUT');
  }
  try {
    if (mode === 'import') await client.importSession(input);
    if (mode === 'refresh-gateway') {
      // Deliberately no legacy-token fallback: report which renewal mechanism works.
      if (!client.s.gateway?.refreshToken) throw new ProtocolError('缺少网关刷新令牌', 'AUTH');
      const body = { refreshToken: client.s.gateway.refreshToken };
      client.acceptGateway(await client.request(GLOBAL, '/base/base-user/token/v1/refresh', {
        method: 'POST', json: body, headers: gatewayHeaders(client.s, body),
      }));
    }
    if (mode === 'refresh-old') await client.refreshOld();
    // Persist rotated credentials before a subsequent status call can fail.
    if (client.s.old && client.s.gateway) persist(client.s);
    await client.status();
    return { ok: true, statusReadable: true };
  } finally {
    if (client.s.old && client.s.gateway) persist(client.s);
  }
}

async function main() {
  const [mode, inputPath] = process.argv.slice(2);
  if (!['import', 'probe', 'refresh-gateway', 'refresh-old'].includes(mode) || (mode === 'import' && !inputPath)) {
    console.error('用法: node src/session-check.mjs import <本地会话文件> | probe | refresh-gateway | refresh-old');
    process.exitCode = 2;
    return;
  }
  let store;
  let client;
  const audit = [];
  let report;
  try {
    const { Store } = await import('./store.mjs');
    const directory = process.env.SESSION_CHECK_DATA_DIR || resolve('data', 'session-check');
    store = new Store(directory);
    const saved = store.session();
    if (mode !== 'import' && !saved) throw new ProtocolError('尚未导入会话', 'NO_SESSION');
    if (mode === 'import' && saved) throw new ProtocolError('验证目录已有会话；请使用新的 SESSION_CHECK_DATA_DIR', 'EXISTS');
    let input;
    if (mode === 'import') {
      if (statSync(inputPath).size > 32000) throw new ProtocolError('会话文件过大', 'INPUT');
      input = JSON.parse(readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
    }
    client = new LeapClient(saved || {}, diagnosticFetch(fetch, audit));
    report = await checkSession(client, mode, value => store.saveSession(value), input);
  } catch (error) {
    // Never print exceptions, response bodies, phone numbers or account identifiers.
    const allowed = new Set(['NO_SESSION', 'EXISTS', 'INPUT', 'AUTH', 'NETWORK', 'BUSINESS', 'SCOPE']);
    report = { ok: false, code: allowed.has(error.code) ? error.code : 'CHECK_FAILED' };
    process.exitCode = 1;
  } finally {
    const expiry = value => Number.isFinite(value) && value > 0 && value < 8.64e15 ? new Date(value).toISOString() : null;
    report = { ...report, mode, checkedAt: new Date().toISOString(),
      oldExpiresAt: expiry(client?.s.old?.expiresAt), gatewayExpiresAt: expiry(client?.s.gateway?.expiresAt),
      gatewayRefreshRequests: audit.filter(path => path.endsWith('/token/v1/refresh')).length,
      oldRefreshRequests: audit.filter(path => path.endsWith('/getnewtoken')).length,
      phoneSessionStillValid: '需在手机手动检查', naturalExpiryVerified: false };
    if (store) {
      store.set('lastSessionCheck', JSON.stringify(report));
      store.db.close();
    }
    console.log(JSON.stringify(report, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
