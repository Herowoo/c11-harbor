const defaults = () => ({ lastPollAt: null, lastSuccessfulPollAt: null,
  lastRenewal: null, lastSuccessfulRenewal: null, gatewayRenewals: 0, legacyRenewals: 0,
  lastReadDiagnostics: null, lastGatewayAttempt: null, lastLegacyAttempt: null });

export function readAuthHealth(store) {
  return { ...defaults(), ...JSON.parse(store.setting('authHealth', '{}')) };
}
export function recordRenewal(store, event) {
  const health = readAuthHealth(store);
  // Only this small, sanitized record can leave the encrypted session boundary.
  const stage = ['gateway-refresh', 'legacy-refresh', 'gateway-exchange'].includes(event.stage)
    ? event.stage : event.kind === 'gateway' ? 'gateway-refresh' : 'legacy-refresh';
  const businessCode = event.code === 'BUSINESS' && /^[a-zA-Z0-9_-]{1,24}$/.test(event.businessCode || '')
    ? event.businessCode : null;
  health.lastRenewal = { kind: event.kind, ok: event.ok, at: event.at, stage, code: event.code,
    businessCode };
  if (event.kind === 'gateway') health.lastGatewayAttempt = health.lastRenewal;
  if (event.kind === 'legacy') health.lastLegacyAttempt = health.lastRenewal;
  if (event.ok) {
    health.lastSuccessfulRenewal = health.lastRenewal;
    if (event.kind === 'gateway') health.gatewayRenewals++;
    if (event.kind === 'legacy') health.legacyRenewals++;
  }
  store.set('authHealth', JSON.stringify(health));
}
export function recordPoll(store, ok, at = Date.now(), diagnostics = null) {
  const health = readAuthHealth(store);
  health.lastPollAt = at;
  if (ok) health.lastSuccessfulPollAt = at;
  if (ok && diagnostics) health.lastReadDiagnostics = diagnostics;
  store.set('authHealth', JSON.stringify(health));
}
export function resetAuthHealth(store) { store.set('authHealth', JSON.stringify(defaults())); }
