import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { promptForSecret, resolveCredentials } from '../src/credentials.js';
import { outputCapture, temporaryDirectory } from '../test-support/helpers.js';

test('resolves passwords from an environment variable', async () => {
  const credentials = await resolveCredentials({
    name: 'default',
    configDirectory: process.cwd(),
    auth: { passwordEnv: 'DEPLOYDO_PASSWORD' },
  }, {
    environment: { DEPLOYDO_PASSWORD: 'secret' },
  });

  assert.equal(credentials.password, 'secret');
});

test('uses a saved password when the configured environment variable is absent', async () => {
  const credentials = await resolveCredentials({
    name: 'default',
    configDirectory: process.cwd(),
    auth: { passwordEnv: 'DEPLOYDO_PASSWORD' },
  }, {
    environment: {},
    passwordStore: {
      get: async () => 'saved-secret',
    },
  });

  assert.equal(credentials.password, 'saved-secret');
});

test('forces a password prompt when replacing a saved password', async () => {
  const credentials = await resolveCredentials({
    name: 'default',
    configDirectory: process.cwd(),
    auth: { passwordEnv: 'DEPLOYDO_PASSWORD' },
  }, {
    environment: { DEPLOYDO_PASSWORD: 'environment-secret' },
    forcePasswordPrompt: true,
    passwordStore: {
      get: async () => {
        throw new Error('The saved password must not be read.');
      },
    },
    promptPassword: async () => 'replacement-secret',
  });

  assert.equal(credentials.password, 'replacement-secret');
});

test('supports password input from stdin without writing files', async () => {
  const input = new PassThrough();
  input.end('stream-secret\n');
  const credentials = await resolveCredentials({
    name: 'default',
    configDirectory: process.cwd(),
    auth: {},
  }, {
    passwordFromStdin: true,
    input,
  });

  assert.equal(credentials.password, 'stream-secret');
});

test('loads a private key and passphrase environment variable for SFTP', async (t) => {
  const directory = await temporaryDirectory(t);
  const keyPath = path.join(directory, 'id_ed25519');
  await fs.writeFile(keyPath, 'private-key');
  const credentials = await resolveCredentials({
    name: 'default',
    configDirectory: directory,
    auth: { privateKeyPath: './id_ed25519', privateKeyPassphraseEnv: 'KEY_PASSWORD' },
  }, {
    environment: { KEY_PASSWORD: 'passphrase' },
  });

  assert.equal(credentials.privateKey.toString(), 'private-key');
  assert.equal(credentials.passphrase, 'passphrase');
});

test('reads the legacy password file only when explicitly allowed', async (t) => {
  const directory = await temporaryDirectory(t);
  const passwordPath = path.join(directory, 'deploy.pw.conf.json');
  await fs.writeFile(passwordPath, '{"default":"old-secret"}', 'utf8');

  const credentials = await resolveCredentials({ name: 'default', configDirectory: directory, auth: {} }, {
    allowLegacyPasswordFile: true,
    legacyPasswordPath: passwordPath,
  });

  assert.equal(credentials.password, 'old-secret');
});

test('masks an interactively entered password', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const output = outputCapture();
  output.stream.isTTY = true;
  const passwordPromise = promptForSecret({ input, output: output.stream, prompt: 'Password: ' });
  input.end('masked-secret\n');

  assert.equal(await passwordPromise, 'masked-secret');
  assert.match(output.text(), /Password:/);
  assert.doesNotMatch(output.text(), /masked-secret/);
});
