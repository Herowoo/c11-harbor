const defaults = () => ({ lastPollAt: null, lastSuccessfulPollAt: null,
  lastRenewal: null, lastSuccessfulRenewal: null, gatewayRenewals: 0, legacyRenewals: 0,
  lastReadDiagnostics: null });

export function readAuthHealth(store) {
  return { ...defaults(), ...JSON.parse(store.setting('authHealth', '{}')) };
}
export function recordRenewal(store, event) {
  const health = readAuthHealth(store);
  // Only this small, sanitized record can leave the encrypted session boundary.
  health.lastRenewal = { kind: event.kind, ok: event.ok, at: event.at, code: event.code };
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
