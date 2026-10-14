import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { concatenate, deriveKey, gatewayHeaders, oldParams, trustedHost } from '../src/protocol.mjs';
import { LeapClient } from '../src/leap-client.mjs';

test('signatures use sorted values and derived gateway key', () => {
  assert.equal(concatenate({ z: 'Z', a: '' }, { b: 'B' }), 'BZ');
  const tail = Buffer.from([1, 2, 3]);
  const token = 'e30.e30.' + tail.toString('base64url');
  const key = deriveKey(token, Buffer.from([3, 2, 1]).toString('base64'), Buffer.from([5, 5, 5]).toString('base64'));
  assert.deepEqual([...key], [7, 5, 7]);
  const session = { deviceId: 'test-device', appVersion: '1.22.95', vin: 'VIN123456789', carType: 'C11',
    old: { accountId: 'account', token: 'legacy' }, gateway: { accessToken: token, signKeyBase64: key.toString('base64') } };
  const signed = gatewayHeaders(session, { vin: 'VIN123456789' }, true, 1700000000000, '123456');
  const input = concatenate({ acceptLanguage: 'zh-CN', channel: '1', deviceId: 'test-device', deviceType: 'android',
    nonce: '123456', source: 'leapmotor', timestamp: '1700000000000', version: '1.22.95' }, { vin: 'VIN123456789' });
  assert.equal(signed.sign, createHmac('sha256', key).update(input).digest('hex'));
  assert.equal(oldParams(session, { vin: 'VIN123456789' }, false, 1700000000000, '456').signStr.length, 16);
});

test('route validation rejects non official hosts', () => {
  assert.equal(trustedHost('https://eu.leapmotor.com/any'), 'https://eu.leapmotor.com');
  assert.throws(() => trustedHost('http://127.0.0.1:9090'));
  assert.throws(() => trustedHost('https://leapmotor.com.evil.example'));
});

test('imported old session exchanges gateway token and gets a vehicle route', async () => {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ path: url.pathname, init });
    const payload = url.pathname.includes('/account/v1/login') ? { result: 0, data: {
      accessToken: 'e30.e30.' + Buffer.from([1, 2]).toString('base64url'), refreshToken: 'new-refresh',
      signParam: { r2: Buffer.from([2, 3]).toString('base64'), r3: Buffer.from([4, 5]).toString('base64') } }
    } : url.pathname.endsWith('/vehicle/list') ? { result: 0, data: { list: [{ vin: 'TESTVIN12345678', carType: 'C11' }] } }
      : { result: 0, data: { appRegion: 'https://cn.leapmotor.com' } };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const client = new LeapClient({}, mockFetch);
  const session = await client.importSession({ deviceId: 'test-device-id', old: { accountId: 'A1', token: 'x'.repeat(64) } });
  assert.equal(session.vin, 'TESTVIN12345678');
  assert.equal(session.appRegion, 'https://cn.leapmotor.com');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].path, '/base/base-user/account/v1/login');
});
