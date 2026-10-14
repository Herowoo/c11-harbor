// Verified names/IDs follow leapauto SignalTable and ChargeStatus, not guesses by ID proximity.
const field = (signals, id, name) => signals[id] ?? signals[name];
const number = (value, unit = '') => {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const text = unit ? raw.replace(new RegExp(`\\s*(?:${unit})$`, 'i'), '').trim() : raw;
  if (!text) return null;
  const result = Number(text);
  return Number.isFinite(result) ? result : null;
};
const bounded = (value, min, max) => value !== null && value >= min && value <= max ? value : null;
const flag = value => ['1', 'true'].includes(String(value).toLowerCase()) ? true
  : ['0', 'false'].includes(String(value).toLowerCase()) ? false : null;
const chargingLabels = { 0: '未插枪', 1: '充电中', 2: '充电完成', 3: '充电故障', 4: '预约等待', 6: '充电暂停' };

export function comfortTelemetry(signals, sourceTime, stale) {
  const interiorTemperature = bounded(number(field(signals, '1349', 'interiorTemp'), '°C|℃'), -50, 100);
  const tires = [
    ['leftFront', '左前', '2646', '2641'], ['rightFront', '右前', '2653', '2648'],
    ['leftRear', '左后', '2660', '2655'], ['rightRear', '右后', '2667', '2662'],
  ].map(([key, label, pressureId, warningId]) => ({ key, label,
    pressureKpa: bounded(number(field(signals, pressureId, `${key}TirePressure`), 'kPa'), 1, 600),
    warning: flag(field(signals, warningId, `${key}TirePressureState`)),
  }));
  const rawState = number(field(signals, '1149', 'chargeState'));
  const state = Number.isInteger(rawState) && rawState in chargingLabels ? rawState : null;
  const isCharging = state === 1;
  const voltage = bounded(number(field(signals, '1177', 'batteryVoltage'), 'V'), 1, 1000);
  const current = bounded(number(field(signals, '1178', 'batteryCurrent'), 'A'), -1000, 1000);
  const rawMinutes = field(signals, '1200', 'chargeRemainTime');
  const minutes = bounded(number(typeof rawMinutes === 'string' ? rawMinutes.replace(/^约\s*/, '') : rawMinutes, '分钟|min'), 0, 10080);
  // Zero remaining minutes while still charging is not evidence of a completed charge.
  const remainingMinutes = isCharging && minutes !== null && minutes > 0 ? Math.ceil(minutes) : null;
  const dc = flag(field(signals, '1197', 'dcInputFastCharge'));
  const ac = flag(field(signals, '47', 'acInputSlowCharge'));
  const power = isCharging && voltage !== null && current !== null ? Math.abs(voltage * current) / 1000 : null;
  return { interiorTemperature, tires, charging: {
    state, label: chargingLabels[state] || '充电状态未上报', isCharging,
    type: dc === true ? '直流快充' : ac === true ? '交流充电' : null,
    powerKw: power !== null && power <= 500 ? Math.round(power * 10) / 10 : null,
    remainingMinutes,
    estimatedFinishAt: remainingMinutes !== null && !stale ? sourceTime + remainingMinutes * 60000 : null,
  } };
}
