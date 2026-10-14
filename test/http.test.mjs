import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('mobile page, login, CSRF and read-only API work without car credentials', async () => {
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_PASSWORD = 'local-test-password-12345';
  process.env.PAIR_BASE_URL = 'https://nas.example.com';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'c11-http-'));
  const { server } = await import('../src/server.mjs');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /出发前，看一眼/);
    assert.match(html, /车况读取诊断/);
    assert.match(html, /id="diagSaved"/);
    assert.equal((await fetch(base + '/api/state')).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
    assert.equal(login.status, 200);
    const { csrf } = await login.json();
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const state = await fetch(base + '/api/state', { headers: { Cookie: cookie } });
    const snapshot = await state.json();
    assert.equal(snapshot.connected, false);
    assert.equal(snapshot.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
    assert.equal(snapshot.authHealth.lastReadDiagnostics, null);
    assert.equal(snapshot.authHealth.lastSuccessfulPollAt, null);
    assert.equal(snapshot.authHealth.gatewayRenewals, 0);
    assert.ok(!('old' in snapshot));
    assert.ok(!('gateway' in snapshot));
    const rejected = await fetch(base + '/api/vehicle/disconnect', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(rejected.status, 403);
    const accepted = await fetch(base + '/api/vehicle/disconnect', { method: 'POST',
      headers: { Cookie: cookie, Origin: base, 'x-harbor-csrf': csrf } });
    assert.equal(accepted.status, 200);
    const missingFile = await fetch(base + '/api/vehicle/import-file', { method: 'POST',
      headers: { Cookie: cookie, Origin: base, 'x-harbor-csrf': csrf } });
    assert.equal(missingFile.status, 400);
    assert.equal((await missingFile.json()).code, 'INPUT');
    const climate = await fetch(base + '/api/climate', { method: 'POST',
      headers: { Cookie: cookie, Origin: base, 'x-harbor-csrf': csrf } });
    assert.equal(climate.status, 403);
    const insecureStart = await fetch(base + '/api/pair/start', { method: 'POST',
      headers: { Cookie: cookie, Origin: base, 'x-harbor-csrf': csrf } });
    assert.equal(insecureStart.status, 403);
    const secureOrigin = `https://127.0.0.1:${server.address().port}`;
    const start = await fetch(base + '/api/pair/start', { method: 'POST',
      headers: { Cookie: cookie, Origin: secureOrigin, 'x-harbor-csrf': csrf } });
    assert.equal(start.status, 200);
    const pair = await start.json();
    assert.match(pair.code, /^[0-9]{8}$/);
    assert.equal(pair.url, 'https://nas.example.com');
    const wrong = await fetch(base + '/api/pair/complete', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '00000000' }) });
    assert.equal(wrong.status, 403);
    const rejectedCode = await fetch(base + '/api/pair/complete', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: 'nas.example.com' },
      body: JSON.stringify({ code: '00000000' }) });
    assert.equal(rejectedCode.status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
