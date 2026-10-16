import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, chinaMonth, chinaToday, recentSevenDays, shiftMonth } from '../public/mileage-view.js';

test('China-local day and month do not depend on the browser timezone', () => {
  const now = Date.parse('2024-04-01T00:20:00+08:00');
  assert.equal(chinaToday(now), '2024-04-01');
  assert.equal(chinaMonth(now), '2024-04');
  assert.equal(shiftMonth('2024-01', -1), '2023-12');
  assert.equal(shiftMonth('2024-12', 1), '2025-01');
});

test('calendar starts Monday, retains zero distance, and distinguishes missing/future days', () => {
  const rows = [{ day: '2024-04-01', distanceKm: 0 }, { day: '2024-04-03', distanceKm: 12 }];
  const days = calendarDays('2024-04', rows, '2024-04-03');
  assert.equal(days.length, 30);
  assert.equal(days[0].day, '2024-04-01');
  assert.equal(days[0].row.distanceKm, 0);
  assert.equal(days[1].row, null);
  assert.equal(days[2].isToday, true);
  assert.equal(days[3].isFuture, true);
  assert.equal(calendarDays('2024-02', [], '2024-02-29').filter(Boolean).length, 29);
});

test('seven day chart always uses consecutive calendar dates, including missing days', () => {
  const days = recentSevenDays([{ day: '2024-04-01', distanceKm: 0 }, { day: '2024-04-07', distanceKm: 8 }], '2024-04-07');
  assert.deepEqual(days.map(day => day.day), ['2024-04-01', '2024-04-02', '2024-04-03', '2024-04-04', '2024-04-05', '2024-04-06', '2024-04-07']);
  assert.equal(days[0].row.distanceKm, 0);
  assert.equal(days[1].row, null);
});
