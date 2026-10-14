import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, normalize } from '../src/store.mjs';

test('captures validated vehicle signals and encrypted session', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'c11-harbor-')));
  const sample = normalize({ '1204': 68, '1318': '13218.8', '1319': 0, '2': 121.5, '3': 31.2,
    '1298': 1, sts: 1700000000 }, 1700000001000);
  assert.equal(sample.soc, 68);
  assert.deepEqual(sample.position, { latitude: 31.2, longitude: 121.5 });
  assert.equal(sample.locked, true);
  assert.equal(store.addSample(sample), true);
  assert.equal(store.addSample(sample), false);
  store.saveSession({ old: { token: 'private-secret' } });
  assert.equal(store.session().old.token, 'private-secret');
  assert.ok(!store.setting('session').includes('private-secret'));
});

test('journal estimates a trip from mileage movement and parked period', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'c11-trip-')));
  const base = 1700000000000;
  const add = (minute, mileage, speed, soc) => store.addSample(normalize({ '1318': mileage, '1319': speed,
    '1204': soc, sts: base + minute * 60000 }, base + minute * 60000));
  add(0, 100, 0, 80);
  add(5, 102, 20, 79);
  add(10, 105, 20, 78);
  add(15, 105, 0, 78);
  add(21, 105, 0, 78);
  assert.equal(store.trips().length, 1);
  assert.equal(store.trips()[0].distanceKm, 5);
  assert.equal(store.trips()[0].quality, '估算');
});

test('an existing V1 database migrates without losing its session, key or historical samples', () => {
  const directory = mkdtempSync(join(tmpdir(), 'c11-migrate-'));
  let store = new Store(directory);
  store.saveSession({ old: { token: 'fixture-session' } });
  store.addSample(normalize({ sts: 1700000000000, '1204': 60 }, 1700000000000));
  const key = readFileSync(join(directory, 'vault.key'));
  for (const column of ['interior_temp', 'tires_json', 'charging_json']) store.db.exec(`ALTER TABLE samples DROP COLUMN ${column}`);
  store.db.close();
  store = new Store(directory);
  assert.equal(store.session().old.token, 'fixture-session');
  assert.equal(store.latest().soc, 60);
  assert.equal(store.latest().interiorTemperature, null);
  assert.deepEqual(readFileSync(join(directory, 'vault.key')), key);
  store.addSample(normalize({ sts: 1700000060000, '1349': 26, '2646': 250, '1149': 1,
    '1177': 400, '1178': -25, '1200': 108 }, 1700000060000));
  assert.equal(store.latest().interiorTemperature, 26);
  assert.equal(store.latest().charging.powerKw, 10);
  store.db.close();
  store = new Store(directory);
  assert.equal(store.latest().tires[0].pressureKpa, 250);
  store.db.close();
});

test('an unchanged cached sample ages even without new vehicle reports, and an old charge cannot give a finish clock', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'c11-aging-')));
  const sourceTime = 1700000000000;
  store.addSample(normalize({ sts: sourceTime, '1149': 1, '1177': 400, '1178': -25,
    '1200': 108 }, sourceTime));
  assert.equal(store.latest(sourceTime + 60000).stale, false);
  assert.equal(store.latest(sourceTime + 60000).charging.estimatedFinishAt, sourceTime + 108 * 60000);
  const aged = store.latest(sourceTime + 11 * 60000);
  assert.equal(aged.stale, true);
  assert.equal(aged.charging.estimatedFinishAt, null);
  assert.equal(aged.charging.powerKw, 10);
  store.db.close();
});

test('equal timestamp refreshes missing migrated fields and persists without rewriting historical sampling', () => {
  const directory = mkdtempSync(join(tmpdir(), 'c11-snapshot-migration-'));
  const source = 1700000000000;
  let store = new Store(directory);
  store.saveSession({ old: { token: 'fixture-session' } });
  store.addSample(normalize({ sts: source, '1204': 60 }, source));
  const key = readFileSync(join(directory, 'vault.key'));
  for (const column of ['interior_temp', 'tires_json', 'charging_json']) store.db.exec(`ALTER TABLE samples DROP COLUMN ${column}`);
  store.db.close();
  store = new Store(directory);
  const received = source + 3 * 3600_000;
  const sample = normalize({ sts: source, '1204': 60, '1349': 26, '2646': 250,
    '1149': 1, '1177': 400, '1178': -25, '1200': 108 }, received);
  assert.equal(store.addSample(sample), false);
  assert.equal(store.latest(received).interiorTemperature, 26);
  assert.equal(store.latest(received).tires[0].pressureKpa, 250);
  assert.equal(store.latest(received).charging.powerKw, 10);
  assert.equal(store.latest(received).charging.estimatedFinishAt, null);
  assert.equal(store.latest(received).stale, true);
  assert.equal(store.latest(received).sourceTime, source);
  assert.equal(store.latest(received).receivedAt, received);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM samples').get().count, 1);
  assert.equal(store.latest(received, false).interiorTemperature, null);
  assert.equal(store.latest(received, false).receivedAt, source);
  store.db.close();
  store = new Store(directory);
  assert.equal(store.latest(received).interiorTemperature, 26);
  assert.equal(store.session().old.token, 'fixture-session');
  assert.deepEqual(readFileSync(join(directory, 'vault.key')), key);
  store.db.close();
});

test('older response cannot overwrite a refreshed snapshot; a new sample replaces it', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'c11-snapshot-order-')));
  const source = 1700000000000;
  store.addSample(normalize({ sts: source, '1204': 80 }, source));
  store.addSample(normalize({ sts: source, '1204': 79 }, source + 1000));
  assert.equal(store.addSample(normalize({ sts: source - 1000, '1204': 20 }, source + 2000)), false);
  assert.equal(store.latest(source + 2000).soc, 79);
  assert.equal(store.addSample(normalize({ sts: source + 1000, '1204': 78 }, source + 3000)), true);
  assert.equal(store.latest(source + 3000).soc, 78);
  assert.equal(store.setting('latestSnapshot'), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM samples').get().count, 2);
  store.db.close();
});

test('snapshot changes never start a trip or alter the historical baseline for the next trip', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'c11-snapshot-trip-')));
  const source = 1700000000000;
  store.addSample(normalize({ sts: source, '1318': 100, '1319': 0 }, source));
  store.addSample(normalize({ sts: source, '1318': 105, '1319': 20 }, source + 1000));
  assert.equal(store.setting('activeTrip'), null);
  assert.equal(store.trips().length, 0);
  store.addSample(normalize({ sts: source + 60000, '1318': 102, '1319': 20 }, source + 60000));
  assert.equal(JSON.parse(store.setting('activeTrip')).startMileage, 100);
  store.db.close();
});
