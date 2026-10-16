export const chinaToday = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
export const chinaMonth = (now = Date.now()) => chinaToday(now).slice(0, 7);
export function shiftMonth(month, step) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + step, 1)).toISOString().slice(0, 7);
}
export function calendarDays(month, rows, today = chinaToday()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const leading = (first.getUTCDay() + 6) % 7;
  const byDay = new Map(rows.map(row => [row.day, row]));
  return Array.from({ length: leading + count }, (_, index) => {
    const numberOfMonth = index - leading + 1;
    if (numberOfMonth < 1) return null;
    const day = `${month}-${String(numberOfMonth).padStart(2, '0')}`;
    return { day, number: numberOfMonth, row: byDay.get(day) || null, isToday: day === today, isFuture: day > today };
  });
}
export function recentSevenDays(rows, today = chinaToday()) {
  const byDay = new Map(rows.map(row => [row.day, row]));
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(end - (6 - index) * 86400_000).toISOString().slice(0, 10);
    return { day, row: byDay.get(day) || null };
  });
}
