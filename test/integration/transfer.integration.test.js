import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadConfiguration } from '../../src/config.js';
import { runDeployment } from '../../src/deploy.js';
import { silentLogger, temporaryDirectory, writeJson } from '../../test-support/helpers.js';

const enabled = process.env.DEPLOYDO_INTEGRATION === '1';
const passwordEnvironment = { DEPLOYDO_TEST_PASSWORD: 'deploydo' };
const fixtures = [
  { name: 'SFTP', protocol: 'sftp', port: 2222, remotePrefix: '/upload' },
  { name: 'FTP', protocol: 'ftp', port: 2121, remotePrefix: '/' },
  {
    name: 'FTPS',
    protocol: 'ftps',
    port: 2122,
    remotePrefix: '/',
    ftps: { mode: 'explicit', rejectUnauthorized: false },
  },
];

for (const fixture of fixtures) {
  test(`${fixture.name} uploads, skips unchanged files, and deletes only managed files`, { skip: !enabled }, async (t) => {
    const directory = await temporaryDirectory(t);
    const sourceDirectory = path.join(directory, 'dist');
    await fs.mkdir(sourceDirectory);
    await fs.writeFile(path.join(sourceDirectory, 'index.html'), '<h1>deploydo</h1>', 'utf8');
    if (fixture.protocol === 'sftp') {
      await fs.writeFile(path.join(sourceDirectory, '.htaccess'), 'Require all granted', 'utf8');
    }

    const runId = `deploydo-${process.pid}-${Date.now()}-${fixture.protocol}`;
    const remotePath = path.posix.join(fixture.remotePrefix, runId);
    await writeJson(path.join(directory, 'deploydo.config.json'), {
      profiles: {
        default: {
          protocol: fixture.protocol,
          host: '127.0.0.1',
          port: fixture.port,
          username: 'deploy',
          sourcePath: 'dist',
          remotePath,
          auth: { passwordEnv: 'DEPLOYDO_TEST_PASSWORD' },
          ...(fixture.ftps ? { ftps: fixture.ftps } : {}),
        },
      },
    });
    const configuration = await loadConfiguration({ cwd: directory });
    const first = await runDeployment({
      configuration,
      yes: true,
      logger: silentLogger(),
      environment: passwordEnvironment,
    });
    const fileCount = fixture.protocol === 'sftp' ? 2 : 1;
    assert.equal(first.uploaded, fileCount);

    const second = await runDeployment({
      configuration,
      yes: true,
      logger: silentLogger(),
      environment: passwordEnvironment,
    });
    assert.equal(second.uploaded, 0);
    assert.equal(second.skipped, fileCount);

    await fs.rm(path.join(sourceDirectory, 'index.html'));
    const third = await runDeployment({
      configuration,
      yes: true,
      deleteRemote: true,
      logger: silentLogger(),
      environment: passwordEnvironment,
    });
    assert.equal(third.deleted, 1);
  });
}
