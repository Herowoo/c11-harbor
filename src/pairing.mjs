import { randomInt, timingSafeEqual } from 'node:crypto';

const TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

export class PairingGate {
  constructor(clock = () => Date.now(), codeFactory = () => String(randomInt(0, 100_000_000)).padStart(8, '0')) {
    this.clock = clock;
    this.codeFactory = codeFactory;
    this.pending = null;
  }

  start() {
    const code = this.codeFactory();
    this.pending = { code, expiresAt: this.clock() + TTL_MS, attempts: 0, busy: false };
    return { code, expiresAt: this.pending.expiresAt };
  }

  status() {
    const p = this.pending;
    return { pending: Boolean(p && p.expiresAt > this.clock()), expiresAt: p?.expiresAt || null };
  }

  claim(code) {
    const p = this.pending;
    if (!p || p.expiresAt <= this.clock() || p.attempts >= MAX_ATTEMPTS || p.busy) return false;
    p.attempts++;
    const candidate = Buffer.from(String(code || '').padEnd(8, ' '));
    const expected = Buffer.from(p.code);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return false;
    p.busy = true;
    return true;
  }

  finish(success) {
    if (!this.pending?.busy) return;
    if (success) this.pending = null;
    else this.pending.busy = false;
  }
}
