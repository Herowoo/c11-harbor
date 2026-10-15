import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mileageRange, parseDailyMileage } from '../src/daily-mileage.mjs';
import { Store } from '../src/store.mjs';

const now = Date.parse('2024-04-08T12:00:00+08:00');
test('official seven-day request uses China midnight and current milliseconds', () => {
  assert.deepEqual(mileageRange(now), {
    begintime: Date.parse('2024-04-01T00:00:00+08:00'), endtime: now });
});

test('daily mileage persists across restart, corrects today, and never treats a zero-day odometer as zero', () => {
  const directory = mkdtempSync(join(tmpdir(), 'c11-daily-'));
  const response = { data: { detail: [
    { day: '2024-04-07', accumulatedMileage: 11, currentMileage: 1234 },
    { day: '2024-04-04', accumulatedMileage: 0, currentMileage: 0 },
    { day: '2024-04-03', accumulatedMileage: 12, currentMileage: 1200 },
    { day: '2024-04-08', accumulatedMileage: 7, currentMileage: 1241 },
    { day: '2024-04-05', accumulatedMileage: 10, currentMileage: 1210 }
  ] } };
  let store = new Store(directory);
  store.saveDailyMileage(parseDailyMileage(response, now), now);
  assert.deepEqual(store.dailyMileage().find(row => row.day === '2024-04-04'), {
    day: '2024-04-04', distanceKm: 0, odometerEndKm: 1200,
    odometerQuality: 'inferred', provisional: false, fetchedAt: now });
  assert.equal(store.dailyMileage()[0].provisional, true);
  store.db.close();
  store = new Store(directory);
  assert.equal(store.dailyMileage()[0].odometerEndKm, 1241);
  response.data.detail[3].accumulatedMileage = 8;
  response.data.detail[3].currentMileage = 1242;
  store.saveDailyMileage(parseDailyMileage(response, now), now + 1);
  assert.equal(store.dailyMileage()[0].distanceKm, 8);
  assert.equal(store.dailyMileage()[0].odometerEndKm, 1242);
  assert.equal(store.dailyMileage().length, 5);
  store.db.close();
});

test('invalid and missing rows cannot fabricate a mileage day', () => {
  const rows = parseDailyMileage({ data: { detail: [
    { day: '2024-02-30', accumulatedMileage: 1, currentMileage: 1 },
    { day: '2024-04-07', accumulatedMileage: null, currentMileage: 1 },
    { day: '2024-04-06', accumulatedMileage: 0, currentMileage: 0 }
  ] } }, now);
  assert.deepEqual(rows, [{ day: '2024-04-06', distanceKm: 0, odometerEndKm: null, provisional: false }]);
  assert.throws(() => parseDailyMileage({ data: { detail: [] } }, now));
});
