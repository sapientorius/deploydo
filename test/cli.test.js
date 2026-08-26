import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runCli } from '../src/cli.js';
import { temporaryDirectory, outputCapture, writeJson } from '../test-support/helpers.js';

const profile = {
  protocol: 'sftp',
  host: 'example.com',
  username: 'deploy',
  sourcePath: 'dist',
  remotePath: '/remote',
  auth: { passwordEnv: 'DEPLOYDO_PASSWORD' },
};

test('returns exit code 2 when configuration is missing', async (t) => {
  const directory = await temporaryDirectory(t);
  const stdout = outputCapture();
  const stderr = outputCapture();

  const exitCode = await runCli(['node', 'deploydo', 'validate'], {
    cwd: directory,
    stdout: stdout.stream,
    stderr: stderr.stream,
    input: new PassThrough(),
  });

  assert.equal(exitCode, 2);
  assert.match(stderr.text(), /No configuration found/);
});

test('validates the legacy --env flag and emits clean JSON', async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = path.join(directory, 'deploydo.config.json');
  await writeJson(configPath, { profiles: { default: profile } });
  const stdout = outputCapture();
  const stderr = outputCapture();

  const exitCode = await runCli(['node', 'deploydo', 'validate', '--env', 'default', '--json'], {
    cwd: directory,
    stdout: stdout.stream,
    stderr: stderr.stream,
    input: new PassThrough(),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), '');
  assert.deepEqual(JSON.parse(stdout.text()), {
    status: 'valid',
    profile: 'default',
    protocol: 'sftp',
    configPath,
    legacy: false,
  });
});

test('initializes and migrates files through the CLI', async (t) => {
  const directory = await temporaryDirectory(t);
  const stdout = outputCapture();
  const stderr = outputCapture();

  const initExit = await runCli(['node', 'deploydo', 'init'], {
    cwd: directory,
    stdout: stdout.stream,
    stderr: stderr.stream,
    input: new PassThrough(),
  });
  assert.equal(initExit, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'deploydo.config.json'), 'utf8')).profiles.default.protocol, 'sftp');

  const legacyPath = path.join(directory, 'legacy.json');
  await writeJson(legacyPath, {
    default: {
      type: 'sftp',
      host: 'example.com',
      user: 'deploy',
      sourcePath: '/dist',
      remotePath: '/remote',
    },
  });
  const migrateExit = await runCli(['node', 'deploydo', 'migrate', '--deployConfigFile', 'legacy.json', '--output', 'migrated.json'], {
    cwd: directory,
    stdout: outputCapture().stream,
    stderr: stderr.stream,
    input: new PassThrough(),
  });

  assert.equal(migrateExit, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'migrated.json'), 'utf8')).profiles.default.sourcePath, 'dist');
});

test('deletes a saved profile password through the credentials command', async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = path.join(directory, 'deploydo.config.json');
  await writeJson(configPath, { profiles: { default: profile } });
  const stdout = outputCapture();
  const removed = [];

  const exitCode = await runCli(['node', 'deploydo', 'credentials', 'delete'], {
    cwd: directory,
    stdout: stdout.stream,
    stderr: outputCapture().stream,
    input: new PassThrough(),
    passwordStore: {
      remove: async (...arguments_) => {
        removed.push(arguments_);
        return true;
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(removed.length, 1);
  assert.match(stdout.text(), /Deleted saved password for profile "default"/);
});
