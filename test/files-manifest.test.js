import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { collectFiles } from '../src/files.js';
import { createManifest, createSyncPlan, parseManifest, serializeManifest } from '../src/manifest.js';
import { temporaryDirectory } from '../test-support/helpers.js';

test('collectFiles includes dotfiles and honours ignore patterns', async (t) => {
  const directory = await temporaryDirectory(t);
  await fs.mkdir(path.join(directory, 'nested'));
  await fs.writeFile(path.join(directory, '.htaccess'), 'Require all granted');
  await fs.writeFile(path.join(directory, 'nested', 'app.js'), 'console.log(1)');
  await fs.writeFile(path.join(directory, 'nested', 'app.js.map'), '{}');
  await fs.writeFile(path.join(directory, 'deploy.pw.conf.json'), '{"default":"secret"}');

  const files = await collectFiles({ sourceDirectory: directory, exclude: ['**/*.map'] });

  assert.deepEqual(files.map((file) => file.relativePath), ['.htaccess', 'nested/app.js']);
  assert.match(files[0].sha256, /^[a-f0-9]{64}$/);
});

test('manifest plans skip unchanged files and only deletes managed paths', () => {
  const files = [
    { relativePath: 'index.html', sha256: 'a'.repeat(64), size: 5 },
    { relativePath: '.htaccess', sha256: 'b'.repeat(64), size: 8 },
  ];
  const oldManifest = {
    version: 1,
    files: {
      'index.html': { sha256: 'a'.repeat(64), size: 5 },
      'obsolete.js': { sha256: 'c'.repeat(64), size: 2 },
    },
  };

  const plan = createSyncPlan(files, oldManifest, { deleteRemote: true });

  assert.deepEqual(plan.uploads.map((file) => file.relativePath), ['.htaccess']);
  assert.deepEqual(plan.skipped.map((file) => file.relativePath), ['index.html']);
  assert.deepEqual(plan.deletions, ['obsolete.js']);
});

test('manifest parsing fails closed for invalid remote data', () => {
  const parsed = parseManifest('{not json');
  assert.equal(parsed.valid, false);
  assert.deepEqual(parsed.manifest.files, {});

  const manifest = createManifest([{ relativePath: 'index.html', sha256: 'a'.repeat(64), size: 1 }]);
  const serialized = serializeManifest(manifest);
  assert.equal(parseManifest(serialized).valid, true);
});
