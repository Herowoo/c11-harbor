import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/store.mjs';

const now = 1700000000000;
test('verified C11-compatible signal names map temperature, four tire positions and battery charging power', () => {
  const sample = normalize({ sts: now, '1349': '31.2 ℃', '2646': '250 kPa', '2653': 260,
    '2660': 240, '2667': 252, '2641': 1, '1149': 1, '1177': '400 V', '1178': '-25 A',
    '1200': '约 108 分钟', '1197': 1 }, now);
  assert.equal(sample.interiorTemperature, 31.2);
  assert.deepEqual(sample.tires.map(t => [t.label, t.pressureKpa]), [['左前', 250], ['右前', 260], ['左后', 240], ['右后', 252]]);
  assert.equal(sample.tires[0].warning, true);
  assert.equal(sample.charging.powerKw, 10);
  assert.equal(sample.charging.remainingMinutes, 108);
  assert.equal(sample.charging.estimatedFinishAt, now + 108 * 60000);
  assert.equal(sample.charging.type, '直流快充');
});

test('zero temperature is valid, invalid or missing telemetry stays unknown, driving current is not charging power', () => {
  const sample = normalize({ sts: now, interiorTemp: 0, leftFrontTirePressure: 0,
    rightFrontTirePressure: 'unknown', leftRearTirePressure: 1000, chargeState: 0,
    batteryVoltage: 400, batteryCurrent: 120 }, now);
  assert.equal(sample.interiorTemperature, 0);
  assert.ok(sample.tires.every(t => t.pressureKpa === null));
  assert.equal(sample.charging.powerKw, null);
  assert.equal(sample.charging.estimatedFinishAt, null);
  assert.equal(normalize({}, now).interiorTemperature, null);
});

test('zero remaining minutes cannot mark an active charge complete, stale samples cannot give a finish clock time', () => {
  const active = normalize({ sts: now, '1149': 1, '1200': 0 }, now);
  assert.equal(active.charging.label, '充电中');
  assert.equal(active.charging.remainingMinutes, null);
  assert.equal(active.charging.estimatedFinishAt, null);
  const stale = normalize({ sts: now - 11 * 60000, chargeState: 1, chargeRemainTime: 60 }, now);
  assert.equal(stale.charging.remainingMinutes, 60);
  assert.equal(stale.charging.estimatedFinishAt, null);
  const completed = normalize({ sts: now, chargeState: 2, batteryVoltage: 400, batteryCurrent: -25, chargeRemainTime: 60 }, now);
  assert.equal(completed.charging.label, '充电完成');
  assert.equal(completed.charging.powerKw, null);
});
