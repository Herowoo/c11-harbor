import test from 'node:test';
import assert from 'node:assert/strict';
import { reportedTimestamp, readDiagnostics } from '../src/read-diagnostics.mjs';
import { Store, normalize } from '../src/store.mjs';
import { recordPoll, readAuthHealth, resetAuthHealth } from '../src/auth-health.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeapClient } from '../src/leap-client.mjs';

const now = Date.UTC(2026, 9, 14, 7, 44);
const old = now - 3 * 3600_000;
const raw = (time = old, soc = 80) => ({ sts: time, '1204': soc, token: 'secret-fixture',
  _timestampCandidates: { signalMap: time, envelope: now, outerData: 'secret-fixture', arbitrary: now } });

test('client preserves selected timestamp and exposes wrapper timestamp candidates only to internal diagnostics', async () => {
  const client = new LeapClient({ appRegion: 'https://cn.leapmotor.com', vin: 'FIXTURE-VIN',
    gateway: { expiresAt: Date.now() + 3600_000, signKeyBase64: 'AQI=', accessToken: 'fixture' } },
  async () => new Response(JSON.stringify({ result: 0, sts: now, data: { sts: now,
    signalMap: { sts: old, '1204': 80 } } })));
  const response = await client.status();
  assert.equal(response.sts, old);
  const diagnostic = readDiagnostics(response, normalize(response, now), null, true, now);
  assert.deepEqual(diagnostic.timestampCandidates.map(item => item.time), [old, now, now, now]);
  assert.equal(JSON.stringify(diagnostic).includes('FIXTURE-VIN'), false);
});

test('same timestamp refreshes display snapshot and diagnostics without changing history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harbor-diagnostic-'));
  const store = new Store(directory);
  try {
    store.addSample(normalize(raw(), now));
    const previous = store.latest(now);
    const response = raw(old, 79);
    const incoming = normalize(response, now);
    const saved = store.addSample(incoming);
    const result = readDiagnostics(response, incoming, previous, saved, now);
    assert.equal(saved, false);
    assert.equal(store.latest(now).soc, 79);
    assert.equal(store.latest(now, false).soc, 80);
    assert.equal(result.reason, 'snapshot_refreshed');
    assert.equal(result.snapshotUpdated, true);
    assert.deepEqual(result.changedFields, ['soc']);
    assert.equal(result.reportedAt, old);
    assert.equal(result.timestampCandidates[1].time, now);
    assert.equal(result.timestampCandidates[2].time, null);
    assert.equal(JSON.stringify(result).includes('secret-fixture'), false);
    assert.equal(JSON.stringify(result).includes('arbitrary'), false);
  } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unchanged, older, newer and first responses have distinct diagnostics', () => {
  const previous = normalize(raw(), now);
  let response = raw();
  assert.deepEqual(readDiagnostics(response, normalize(response, now), previous, false, now).changedFields, []);
  response = raw(old - 1000);
  assert.equal(readDiagnostics(response, normalize(response, now), previous, false, now).reason, 'older_timestamp');
  response = raw(now);
  assert.equal(readDiagnostics(response, normalize(response, now), previous, true, now).reason, 'saved');
  assert.equal(readDiagnostics(response, normalize(response, now), null, true, now).previousReportedAt, null);
});

test('seconds are accepted; missing, boolean, invalid and future times are not called vehicle reports', () => {
  assert.equal(reportedTimestamp(now / 1000, now), now);
  for (const value of [null, undefined, '', true, {}, 'not-a-time', now + 61_000, 0]) {
    assert.equal(reportedTimestamp(value, now), null);
    const response = raw(value);
    response.sts = value;
    assert.equal(readDiagnostics(response, normalize(response, now), null, true, now).timestampMissing, true);
  }
});

test('poll diagnostics survive a failed poll and reset on a new session', () => {
  const settings = new Map();
  const store = { setting: (key, fallback) => settings.get(key) ?? fallback, set: (key, value) => settings.set(key, value) };
  const diagnostic = readDiagnostics(raw(), normalize(raw(), now), null, true, now);
  recordPoll(store, true, now, diagnostic);
  recordPoll(store, false, now + 1);
  assert.deepEqual(readAuthHealth(store).lastReadDiagnostics, diagnostic);
  assert.equal(readAuthHealth(store).lastSuccessfulPollAt, now);
  resetAuthHealth(store);
  assert.equal(readAuthHealth(store).lastReadDiagnostics, null);
});
