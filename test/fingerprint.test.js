import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSshSha256Fingerprint } from '../src/fingerprint.js';

test('normalizes OpenSSH and hexadecimal SHA-256 fingerprints', () => {
  const fingerprint = 'a'.repeat(64);
  assert.equal(normalizeSshSha256Fingerprint(fingerprint), fingerprint);

  const base64 = Buffer.alloc(32).toString('base64');
  assert.equal(normalizeSshSha256Fingerprint(`SHA256:${base64}`), '00'.repeat(32));
});

test('rejects invalid host fingerprints', () => {
  assert.throws(() => normalizeSshSha256Fingerprint('not-a-fingerprint'), /SHA-256/);
});
