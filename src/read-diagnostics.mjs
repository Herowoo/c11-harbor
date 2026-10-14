// Diagnostics contain timestamps, fixed field names and booleans only, never values.
const fields = ['soc', 'range', 'mileage', 'speed', 'gear', 'driving', 'locked', 'ac',
  'interiorTemperature', 'tires', 'charging', 'position'];
export function reportedTimestamp(value, now) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const numeric = Number(value);
  const time = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return Number.isFinite(time) && time > 946_684_800_000 && time <= now + 60_000 ? time : null;
}
export function readDiagnostics(raw, incoming, previous, saved, now = Date.now()) {
  const reportedAt = reportedTimestamp(raw.sts, now);
  const candidates = raw._timestampCandidates || {};
  return {
    queriedAt: now, reportedAt, normalizedAt: incoming.sourceTime,
    previousReportedAt: previous?.sourceTime ?? null,
    previousReceivedAt: previous?.receivedAt ?? null,
    saved: Boolean(saved),
    snapshotUpdated: Boolean(!saved && previous && incoming.sourceTime === previous.sourceTime),
    reason: saved ? 'saved' : !previous ? 'not_saved'
      : incoming.sourceTime === previous.sourceTime ? 'snapshot_refreshed' : 'older_timestamp',
    timestampMissing: reportedAt === null,
    changedFields: previous ? fields.filter(field =>
      JSON.stringify(incoming[field] ?? null) !== JSON.stringify(previous[field] ?? null)) : [],
    timestampCandidates: ['signalMap', 'envelope', 'outerData', 'outer'].map(field => ({
      field, time: reportedTimestamp(candidates[field], now)
    }))
  };
}
