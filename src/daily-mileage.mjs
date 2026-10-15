import { ProtocolError } from './protocol.mjs';

const chinaDay = ms => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
export function mileageRange(now = Date.now()) {
  const today = chinaDay(now);
  return { begintime: Date.parse(`${today}T00:00:00+08:00`) - 7 * 86400_000, endtime: now };
}

export function parseDailyMileage(response, now = Date.now()) {
  if (!Array.isArray(response?.data?.detail)) throw new ProtocolError('每日里程响应缺少明细');
  const today = chinaDay(now);
  const rows = response.data.detail.flatMap(item => {
    const day = item?.day;
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        Number.isNaN(Date.parse(`${day}T00:00:00+08:00`)) ||
        chinaDay(Date.parse(`${day}T00:00:00+08:00`)) !== day || day > today ||
        item.accumulatedMileage === null || item.accumulatedMileage === undefined || item.accumulatedMileage === '') return [];
    const distance = Number(item.accumulatedMileage);
    if (!Number.isFinite(distance) || distance < 0 || distance > 3000) return [];
    const odometer = Number(item.currentMileage);
    return [{ day, distanceKm: distance,
      odometerEndKm: Number.isFinite(odometer) && odometer > 0 && odometer <= 2_000_000 ? odometer : null,
      provisional: day === today }];
  });
  if (!rows.length) throw new ProtocolError('每日里程响应没有有效日期或里程');
  return rows.sort((a, b) => a.day.localeCompare(b.day));
}
