import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CONFIG_FILE,
  legacyDocumentToModernDocument,
  loadConfiguration,
  writeModernConfig,
} from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { temporaryDirectory, writeJson } from '../test-support/helpers.js';

const modernProfile = {
  protocol: 'sftp',
  host: 'example.com',
  username: 'deploy',
  sourcePath: 'dist',
  remotePath: '/public_html',
  auth: { passwordEnv: 'DEPLOYDO_PASSWORD' },
};

test('loads a V3 configuration relative to its file', async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = path.join(directory, DEFAULT_CONFIG_FILE);
  await writeJson(configPath, { profiles: { default: modernProfile } });

  const configuration = await loadConfiguration({ cwd: directory });

  assert.equal(configuration.legacy, false);
  assert.equal(configuration.profile.port, 22);
  assert.equal(configuration.profile.sourceDirectory, path.join(directory, 'dist'));
  assert.deepEqual(configuration.profile.exclude, []);
});

test('loads V2 profiles with their legacy source path semantics', async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = path.join(directory, 'legacy.json');
  await writeJson(configPath, {
    default: {
      type: 'sftp',
      host: 'example.com',
      port: '22',
      user: 'deploy',
      sourcePath: '/dist',
      remotePath: '/public_html',
      ignore: '**/*.map',
      useCache: true,
      buildCommand: 'npm run build',
    },
  });

  const configuration = await loadConfiguration({ cwd: directory, configPath: 'legacy.json' });

  assert.equal(configuration.legacy, true);
  assert.equal(configuration.profile.sourceDirectory, path.join(directory, 'dist'));
  assert.deepEqual(configuration.profile.exclude, ['**/*.map']);
  assert.equal(configuration.profile.buildCommand, 'npm run build');
});

test('accepts V2 null ignore settings and preserves legacy verbosity', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeJson(path.join(directory, 'legacy.json'), {
    default: {
      type: 'sftp',
      host: 'example.com',
      user: 'deploy',
      sourcePath: '/dist',
      remotePath: '/public_html',
      ignore: null,
      verbose: true,
    },
  });

  const configuration = await loadConfiguration({ cwd: directory, configPath: 'legacy.json' });

  assert.deepEqual(configuration.profile.exclude, []);
  assert.equal(configuration.profile.verbose, true);
});

test('reports malformed configurations precisely', async (t) => {
  const directory = await temporaryDirectory(t);
  await fs.writeFile(path.join(directory, DEFAULT_CONFIG_FILE), '{invalid', 'utf8');

  await assert.rejects(
    loadConfiguration({ cwd: directory }),
    (error) => error instanceof ConfigError && /Invalid JSON/.test(error.message),
  );
});

test('rejects private keys for FTP profiles', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeJson(path.join(directory, DEFAULT_CONFIG_FILE), {
    profiles: {
      default: {
        ...modernProfile,
        protocol: 'ftp',
        auth: { privateKeyPath: './id_ed25519' },
      },
    },
  });

  await assert.rejects(
    loadConfiguration({ cwd: directory }),
    (error) => error instanceof ConfigError && /only supported by SFTP/.test(error.message),
  );
});

test('rejects SFTP host pins for FTP profiles', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeJson(path.join(directory, DEFAULT_CONFIG_FILE), {
    profiles: {
      default: {
        ...modernProfile,
        protocol: 'ftp',
        auth: { hostFingerprint: 'a'.repeat(64) },
      },
    },
  });

  await assert.rejects(
    loadConfiguration({ cwd: directory }),
    (error) => error instanceof ConfigError && /only supported by SFTP/.test(error.message),
  );
});

test('migration strips legacy path notation and never copies passwords', async (t) => {
  const directory = await temporaryDirectory(t);
  const legacyPath = path.join(directory, 'legacy.json');
  const legacy = {
    default: {
      type: 'sftp',
      host: 'example.com',
      user: 'deploy',
      sourcePath: '/dist',
      remotePath: '/public_html',
      useCache: false,
    },
  };
  await writeJson(legacyPath, legacy);

  const converted = legacyDocumentToModernDocument(legacy);
  assert.equal(converted.profiles.default.sourcePath, 'dist');
  assert.deepEqual(converted.profiles.default.auth, {});
  assert.equal(converted.profiles.default.sync.useManifest, false);

  const destination = await writeModernConfig({ sourcePath: legacyPath, destinationPath: 'migrated.json', cwd: directory });
  const saved = JSON.parse(await fs.readFile(destination, 'utf8'));
  assert.deepEqual(saved, converted);
});
