import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionFile } from '../src/session-file.mjs';

test('offline import accepts a UTF-8 BOM and rejects invalid or oversized files without leaking contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harbor-file-'));
  const path = join(directory, 'session.json');
  writeFileSync(path, '\uFEFF{"deviceId":"test-device"}');
  assert.deepEqual(readSessionFile(path), { deviceId: 'test-device' });
  writeFileSync(path, 'secret-not-json');
  assert.throws(() => readSessionFile(path), e => e.code === 'INPUT' && !e.message.includes('secret-not-json'));
  writeFileSync(path, 'x'.repeat(32001));
  assert.throws(() => readSessionFile(path));
  assert.throws(() => readSessionFile(join(directory, 'missing')));
});
