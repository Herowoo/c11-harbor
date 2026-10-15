import test from 'node:test';
import assert from 'node:assert/strict';
import { LeapClient } from '../src/leap-client.mjs';
import { recordRenewal, recordPoll, readAuthHealth } from '../src/auth-health.mjs';

const gatewayData = refreshToken => ({ result: 0, data: {
  accessToken: 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.AQI',
  refreshToken, signParam: { r2: 'AgM=', r3: 'BAU=' } } });
const session = () => ({ deviceId: 'test-device', phone: '13800138000', appRegion: 'https://cn.leapmotor.com', vin: 'FIXTURE-VIN',
  old: { accountId: 'test-account', token: 'old-token', refreshToken: 'old-refresh' },
  gateway: { accessToken: 'e30.e30.AQI', refreshToken: 'gateway-before', signKeyBase64: 'AQI=', expiresAt: 0 } });

test('successful gateway renewal checkpoints before a subsequent telemetry request fails', async () => {
  const saved = []; const events = [];
  const client = new LeapClient(session(), async url => {
    if (url.pathname.endsWith('/token/v1/refresh')) return new Response(JSON.stringify(gatewayData('gateway-after')));
    throw new Error('simulated temporary network outage');
  }, { onSessionChange: s => saved.push(structuredClone(s)), onRenewal: e => events.push(e) });
  await assert.rejects(client.status(), error => error.code === 'NETWORK');
  assert.equal(saved.at(-1).gateway.refreshToken, 'gateway-after');
  assert.equal(events[0].ok, true);
  assert.equal(events[0].kind, 'gateway');
});

test('legacy renewal checkpoints the new legacy token even when gateway exchange fails', async () => {
  const saved = [];
  const client = new LeapClient(session(), async url => {
    if (url.pathname.endsWith('/getnewtoken')) return new Response(JSON.stringify({ result: 0, data: {
      token: 'legacy-after', refreshToken: 'legacy-refresh-after', tokenExpired: 21600 } }));
    throw new Error('simulated gateway outage');
  }, { onSessionChange: s => saved.push(structuredClone(s)) });
  await assert.rejects(client.refreshOld());
  assert.equal(saved.at(-1).old.refreshToken, 'legacy-refresh-after');
});

test('a persistence error is not silently treated as a need to refresh another token', async () => {
  let requests = 0;
  const client = new LeapClient(session(), async () => {
    requests++; return new Response(JSON.stringify(gatewayData('rotated')));
  }, { onSessionChange: () => { throw new Error('disk unavailable'); } });
  await assert.rejects(client.refreshGateway(), error => error.code === 'STORAGE');
  assert.equal(requests, 1);
});

test('session health records successful polling independently of cached telemetry and never stores extra credentials', () => {
  const settings = new Map();
  const store = { setting: (k, fallback) => settings.get(k) ?? fallback, set: (k, value) => settings.set(k, value) };
  recordPoll(store, true, 100);
  recordPoll(store, false, 200);
  recordRenewal(store, { kind: 'gateway', ok: true, at: 300, code: null, token: 'must-not-leak' });
  recordRenewal(store, { kind: 'legacy', ok: false, at: 400, code: 'AUTH' });
  const health = readAuthHealth(store);
  assert.equal(health.lastSuccessfulPollAt, 100);
  assert.equal(health.lastPollAt, 200);
  assert.equal(health.gatewayRenewals, 1);
  assert.equal(health.lastSuccessfulRenewal.at, 300);
  assert.ok(!settings.get('authHealth').includes('must-not-leak'));
});

test('gateway and legacy business failures keep separate safe stages and business codes', async () => {
  const settings = new Map();
  const store = { setting: (k, fallback) => settings.get(k) ?? fallback, set: (k, value) => settings.set(k, value) };
  const client = new LeapClient(session(), async url => {
    if (url.pathname.endsWith('/token/v1/refresh')) return new Response(JSON.stringify({ result: 39 }));
    if (url.pathname.endsWith('/getnewtoken')) return new Response(JSON.stringify({ result: 45,
      msg: 'private-token-must-not-leak' }));
    throw new Error('unexpected fixture URL');
  }, { onRenewal: event => recordRenewal(store, event) });
  await assert.rejects(client.refreshGateway(), error => error.code === 'BUSINESS');
  const health = readAuthHealth(store);
  assert.equal(health.lastGatewayAttempt.stage, 'gateway-refresh');
  assert.equal(health.lastGatewayAttempt.code, 'AUTH');
  assert.equal(health.lastLegacyAttempt.stage, 'legacy-refresh');
  assert.equal(health.lastLegacyAttempt.businessCode, '45');
  assert.equal(JSON.stringify(health).includes('private-token-must-not-leak'), false);
});

test('legacy token acceptance followed by gateway exchange rejection is identified', async () => {
  const events = [];
  const saved = [];
  const client = new LeapClient(session(), async url => {
    if (url.pathname.endsWith('/getnewtoken')) return new Response(JSON.stringify({ result: 0, data: {
      token: 'rotated-token', refreshToken: 'rotated-refresh', tokenExpired: 21600 } }));
    if (url.pathname.endsWith('/account/v1/login')) return new Response(JSON.stringify({ result: 45 }));
    throw new Error('unexpected fixture URL');
  }, { onSessionChange: value => saved.push(structuredClone(value)), onRenewal: event => events.push(event) });
  await assert.rejects(client.refreshOld(), error => error.code === 'BUSINESS');
  assert.equal(saved.at(-1).old.refreshToken, 'rotated-refresh');
  assert.equal(events.at(-1).stage, 'gateway-exchange');
  assert.equal(events.at(-1).businessCode, '45');
});
