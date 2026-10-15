import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { comfortTelemetry } from './telemetry.mjs';

const safeNumber = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const field = (signals, id, name) => signals?.[id] ?? signals?.[name];
const plausible = (value, min, max) => value !== null && value >= min && value <= max;
const timestamp = (raw, receivedAt) => {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return receivedAt;
  const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return ms > 946_684_800_000 && ms <= receivedAt + 60_000 ? ms : receivedAt;
};

export function normalize(signals, receivedAt = Date.now()) {
  const mileage = safeNumber(field(signals, '1318', 'totalMileage'));
  const soc = safeNumber(field(signals, '1204', 'soc'));
  const speed = safeNumber(field(signals, '1319', 'speed'));
  const lat = safeNumber(field(signals, '3', 'latitude'));
  const lon = safeNumber(field(signals, '2', 'longitude'));
  const validCoord = plausible(lat, -90, 90) && plausible(lon, -180, 180) && !(lat === 0 && lon === 0);
  const gear = field(signals, '1010', 'gearStatus');
  const vehicleState = field(signals, '1944', 'vehicleState');
  const locked = field(signals, '1298', 'driverDoorLockStatus');
  const ac = field(signals, '1938', 'acSwitch');
  const sourceTime = timestamp(signals.sts, receivedAt);
  const rawTime = Number(signals.sts);
  const rawEpoch = rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime;
  const hasVehicleTime = signals.sts !== null && signals.sts !== undefined && signals.sts !== '' &&
    Number.isFinite(rawEpoch) && rawEpoch >= 946_684_800_000 && rawEpoch <= receivedAt + 60_000;
  const stale = !hasVehicleTime || receivedAt - sourceTime > 10 * 60_000;
  return {
    sourceTime, receivedAt,
    mileage: plausible(mileage, 0, 2_000_000) ? mileage : null,
    soc: plausible(soc, 0, 100) ? soc : null,
    range: safeNumber(field(signals, '2188', 'liveRemainingRange')) ?? safeNumber(field(signals, '3260', 'expectedMileage')),
    speed: plausible(speed, 0, 300) ? speed : null,
    gear: gear == null ? null : String(gear),
    driving: (speed !== null && speed > 3) || String(vehicleState) === '1' || String(gear).toUpperCase() === 'D',
    locked: locked == null ? null : String(locked) === '1',
    ac: ac == null ? null : ['1', 'true'].includes(String(ac).toLowerCase()),
    position: validCoord ? { latitude: lat, longitude: lon } : null,
    // Only expose source vs receive time; stale vehicle data must not look live.
    stale,
    ...comfortTelemetry(signals, sourceTime, stale)
  };
}

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'vault.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    chmodSync(keyPath, 0o600);
    this.key = readFileSync(keyPath);
    this.db = new DatabaseSync(join(directory, 'harbor.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY, source_time INTEGER NOT NULL, received_at INTEGER NOT NULL,
        mileage REAL, soc REAL, range_km REAL, speed REAL, gear TEXT, driving INTEGER,
        locked INTEGER, ac INTEGER, latitude REAL, longitude REAL, stale INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_samples_time ON samples(source_time);
      CREATE TABLE IF NOT EXISTS trips (
        id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
        start_mileage REAL, end_mileage REAL, distance_km REAL, start_soc REAL, end_soc REAL,
        start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL, quality TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, requested_at INTEGER NOT NULL,
        status TEXT NOT NULL, message TEXT NOT NULL);
    `);
    // Additive migration retains existing samples, trips, encrypted credentials and vault key.
    const columns = new Set(this.db.prepare('PRAGMA table_info(samples)').all().map(column => column.name));
    for (const [name, type] of [['interior_temp', 'REAL'], ['tires_json', 'TEXT'], ['charging_json', 'TEXT']]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE samples ADD COLUMN ${name} ${type}`);
    }
    this.directory = directory;
  }
  setting(key, fallback = null) { return this.db.prepare('SELECT value FROM config WHERE key=?').get(key)?.value ?? fallback; }
  set(key, value) { this.db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  decrypt(value) {
    if (!value) return null;
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString());
  }
  session() { return this.decrypt(this.setting('session')); }
  saveSession(session) { this.set('session', this.encrypt(session)); }
  clearSession() { this.db.prepare('DELETE FROM config WHERE key=?').run('session'); }
  latest(now = Date.now(), includeSnapshot = true) {
    const row = this.db.prepare('SELECT * FROM samples ORDER BY id DESC LIMIT 1').get();
    if (!row) return null;
    const snapshot = includeSnapshot ? JSON.parse(this.setting('latestSnapshot', 'null')) : null;
    if (snapshot?.sourceTime === row.source_time) {
      const result = structuredClone(snapshot);
      result.stale = Boolean(result.stale) || now - result.sourceTime > 10 * 60_000;
      if (result.stale && result.charging) result.charging.estimatedFinishAt = null;
      return result;
    }
    const stale = Boolean(row.stale) || now - row.source_time > 10 * 60_000;
    const charging = row.charging_json ? JSON.parse(row.charging_json) : null;
    if (stale && charging) charging.estimatedFinishAt = null;
    return { sourceTime: row.source_time, receivedAt: row.received_at, mileage: row.mileage,
      soc: row.soc, range: row.range_km, speed: row.speed, gear: row.gear,
      driving: row.driving === null ? null : Boolean(row.driving),
      locked: row.locked === null ? null : Boolean(row.locked), ac: row.ac === null ? null : Boolean(row.ac),
      stale, position: row.latitude === null ? null : { latitude: row.latitude, longitude: row.longitude },
      interiorTemperature: row.interior_temp ?? null,
      tires: row.tires_json ? JSON.parse(row.tires_json) : [],
      charging };
  }
  addSample(sample) {
    const last = this.latest(Date.now(), false);
    if (last && sample.sourceTime === last.sourceTime) {
      this.set('latestSnapshot', JSON.stringify(sample));
      this.detectTrip(sample);
      return false;
    }
    if (last && sample.sourceTime < last.sourceTime) return false;
    this.db.prepare(`INSERT INTO samples(source_time,received_at,mileage,soc,range_km,speed,gear,driving,locked,ac,latitude,longitude,stale,interior_temp,tires_json,charging_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sample.sourceTime, sample.receivedAt, sample.mileage, sample.soc,
      sample.range, sample.speed, sample.gear, sample.driving ? 1 : 0,
      sample.locked === null ? null : Number(sample.locked), sample.ac === null ? null : Number(sample.ac),
      sample.position?.latitude ?? null, sample.position?.longitude ?? null, Number(sample.stale),
      sample.interiorTemperature ?? null, JSON.stringify(sample.tires ?? []), JSON.stringify(sample.charging ?? null));
    this.db.prepare('DELETE FROM config WHERE key=?').run('latestSnapshot');
    this.detectTrip(sample);
    return true;
  }
  detectTrip(sample) {
    // Source timestamps may remain frozen while the signal values change. Use the NAS
    // observation time for segmentation and explicitly mark such trips as uncertain.
    const previous = JSON.parse(this.setting('lastTripObservation', 'null'));
    const observed = { at: sample.receivedAt, sourceTime: sample.sourceTime,
      mileage: sample.mileage, soc: sample.soc, position: sample.position,
      stale: sample.stale, driving: sample.driving };
    if (previous && observed.at <= previous.at) return;
    this.set('lastTripObservation', JSON.stringify(observed));
    if (!previous || sample.mileage === null || previous.mileage === null) return;
    const active = JSON.parse(this.setting('activeTrip', 'null'));
    // Do not combine an in-flight trip from the old source-time algorithm with
    // the new receipt-time clock after an upgrade.
    if (active && active.mode !== 'observed') {
      this.set('activeTrip', 'null');
      return;
    }
    if (!active) {
      const delta = sample.mileage - previous.mileage;
      if (delta <= 0.2 || delta > 200) return;
      const vehicleTimeUncertain = sample.stale || previous.stale || sample.sourceTime === previous.sourceTime;
      this.set('activeTrip', JSON.stringify({ mode: 'observed', startedAt: previous.at, startMileage: previous.mileage,
        startSoc: previous.soc, startPosition: previous.position, lastMovingAt: observed.at,
        lastMileage: sample.mileage, lastSoc: sample.soc, lastPosition: sample.position,
        uncertain: observed.at - previous.at > 30 * 60_000, vehicleTimeUncertain }));
      return;
    }
    if (observed.at - previous.at > 30 * 60_000) active.uncertain = true;
    if (sample.stale || previous.stale || sample.sourceTime === previous.sourceTime) active.vehicleTimeUncertain = true;
    const delta = sample.mileage - active.lastMileage;
    if (delta < -1 || delta > 200) active.uncertain = true;
    if ((delta > 0.1 && delta <= 200) || (!sample.stale && sample.driving)) {
      active.lastMovingAt = observed.at;
      active.lastMileage = sample.mileage;
      active.lastSoc = sample.soc;
      active.lastPosition = sample.position || active.lastPosition;
    } else if (observed.at - active.lastMovingAt >= 5 * 60_000) {
      const distance = active.lastMileage - active.startMileage;
      if (distance >= 0.2 && distance <= 500) {
        const quality = ['估算', active.vehicleTimeUncertain ? '车端时间未更新' : null,
          active.uncertain ? '存在数据缺口' : null].filter(Boolean).join('·');
        this.db.prepare(`INSERT INTO trips(started_at,ended_at,start_mileage,end_mileage,distance_km,start_soc,end_soc,start_lat,start_lon,end_lat,end_lon,quality)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(active.startedAt, active.lastMovingAt, active.startMileage, active.lastMileage,
          Math.round(distance * 10) / 10, active.startSoc, active.lastSoc,
          active.startPosition?.latitude ?? null, active.startPosition?.longitude ?? null,
          active.lastPosition?.latitude ?? null, active.lastPosition?.longitude ?? null,
          quality);
      }
      this.set('activeTrip', 'null'); return;
    }
    this.set('activeTrip', JSON.stringify(active));
  }
  trips(limit = 30) {
    return this.db.prepare('SELECT id,started_at AS startedAt,ended_at AS endedAt,distance_km AS distanceKm,start_soc AS startSoc,end_soc AS endSoc,quality FROM trips ORDER BY id DESC LIMIT ?').all(limit);
  }
  days(limit = 14) {
    return this.db.prepare(`SELECT date(ended_at/1000,'unixepoch','+8 hours') AS day, ROUND(SUM(distance_km),1) AS distanceKm,
      COUNT(*) AS tripCount FROM trips GROUP BY day ORDER BY day DESC LIMIT ?`).all(limit);
  }
  command(id, action, status, message) {
    this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run(id, action, Date.now(), status, message);
  }
  updateCommand(id, status, message) { this.db.prepare('UPDATE commands SET status=?, message=? WHERE id=?').run(status, message, id); }
  getCommand(id) { return this.db.prepare('SELECT * FROM commands WHERE id=?').get(id); }
  recentCommand() { return this.db.prepare('SELECT * FROM commands ORDER BY requested_at DESC LIMIT 1').get(); }
  recoverCommands() {
    this.db.prepare("UPDATE commands SET status='待确认', message='服务重启，之前的指令结果未知；请检查车辆状态' WHERE status='处理中'").run();
  }
  prune(days = 90) {
    this.db.prepare('DELETE FROM samples WHERE source_time < ?').run(Date.now() - days * 86400000);
    this.db.prepare('DELETE FROM commands WHERE requested_at < ?').run(Date.now() - 30 * 86400000);
  }
}
