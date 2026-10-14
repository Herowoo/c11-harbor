import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, normalize } from '../src/store.mjs';
import { recordPoll, recordRenewal } from '../src/auth-health.mjs';

process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'preview-local-password';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'c11-preview-'));
process.env.AMAP_WEB_KEY = '';
process.env.PAIR_BASE_URL = '';
const store = new Store(process.env.DATA_DIR);
const now = Date.now();
store.saveSession({ name: '演示数据 · 零跑 C11', old: { token: 'fixture', expiresAt: now + 21600000 },
  gateway: { expiresAt: now + 3600000 } });
store.addSample(normalize({ sts: now, '1204': 68, '2188': 320, '1318': 13218.8,
  '1298': 1, '1938': 0, '1349': 26.4, '2646': 250, '2653': 252, '2660': 248, '2667': 250,
  '2641': 0, '2648': 0, '2655': 0, '2662': 0, '1149': 1, '1177': 382, '1178': -25,
  '1200': 108, '47': 1, '2': 121.5, '3': 31.2 }, now));
recordPoll(store, true);
recordRenewal(store, { kind: 'gateway', ok: true, at: now - 60000, code: null });
store.db.close();
// No real car request can happen, even if the preview refresh button is clicked.
globalThis.fetch = async () => { throw new Error('Preview does not allow outbound API requests'); };
const { server } = await import('../src/server.mjs');
server.listen(8091, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:8091 · password: preview-local-password'));
