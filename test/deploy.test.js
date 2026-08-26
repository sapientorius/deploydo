import assert from 'node:assert/strict';
import test from 'node:test';

import { runDeployment } from '../src/deploy.js';
import { UsageError } from '../src/errors.js';
import { createManifest, serializeManifest } from '../src/manifest.js';
import { silentLogger } from '../test-support/helpers.js';

class FakeTransport {
  constructor({ manifest = null, failUpload = false, failReplace = false } = {}) {
    this.manifest = manifest;
    this.failUpload = failUpload;
    this.failReplace = failReplace;
    this.connected = 0;
    this.downloaded = [];
    this.uploaded = [];
    this.buffers = [];
    this.deleted = [];
    this.replaced = [];
    this.closed = 0;
  }

  async connect() {
    this.connected += 1;
  }

  async download(remotePath) {
    this.downloaded.push(remotePath);
    return this.manifest;
  }

  async uploadFile(localPath, remotePath) {
    if (this.failUpload) throw new Error('upload failed');
    this.uploaded.push({ localPath, remotePath });
  }

  async uploadBuffer(content, remotePath) {
    this.buffers.push({ content: content.toString('utf8'), remotePath });
  }

  async replace(fromPath, toPath) {
    if (this.failReplace) throw new Error('rename disabled');
    this.replaced.push({ fromPath, toPath });
  }

  async remove(remotePath) {
    this.deleted.push(remotePath);
  }

  async close() {
    this.closed += 1;
  }
}

function configuration({ sync = { useManifest: true, manifestPath: '.deploydo-manifest.json' }, buildCommand } = {}) {
  return {
    cwd: process.cwd(),
    configDirectory: process.cwd(),
    legacy: false,
    profileName: 'default',
    profile: {
      name: 'default',
      protocol: 'sftp',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      sourceDirectory: process.cwd(),
      remotePath: '/remote',
      exclude: [],
      auth: { passwordEnv: 'DEPLOYDO_PASSWORD' },
      connection: { retries: 0 },
      sync,
      buildCommand,
    },
  };
}

const localFile = {
  localPath: '/tmp/index.html',
  relativePath: 'index.html',
  sha256: 'a'.repeat(64),
  size: 5,
};

function deploymentDependencies(transport, files = [localFile]) {
  return {
    collectFiles: async () => files,
    createTransport: () => transport,
    resolveCredentials: async () => ({ password: 'secret' }),
  };
}

test('dry runs read the manifest but make no remote writes', async () => {
  const transport = new FakeTransport({
    manifest: Buffer.from(serializeManifest(createManifest([localFile]))),
  });

  const result = await runDeployment({
    configuration: configuration(),
    dryRun: true,
    logger: silentLogger(),
    dependencies: deploymentDependencies(transport),
  });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.plannedUploads, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(transport.uploaded, []);
  assert.deepEqual(transport.deleted, []);
  assert.deepEqual(transport.buffers, []);
  assert.equal(transport.closed, 1);
});

test('saves a password only after the connection succeeds', async () => {
  const transport = new FakeTransport();
  const saved = [];

  await runDeployment({
    configuration: configuration(),
    dryRun: true,
    savePassword: true,
    logger: silentLogger(),
    dependencies: {
      ...deploymentDependencies(transport),
      passwordStore: {
        save: async (...arguments_) => saved.push(arguments_),
      },
    },
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0][1], 'secret');
  assert.equal(transport.connected, 1);
});

test('does not save a password when authentication fails', async () => {
  const saved = [];
  const transport = new FakeTransport();
  transport.connect = async () => {
    throw new Error('authentication failed');
  };

  await assert.rejects(
    runDeployment({
      configuration: configuration(),
      dryRun: true,
      savePassword: true,
      logger: silentLogger(),
      dependencies: {
        ...deploymentDependencies(transport),
        passwordStore: {
          save: async (...arguments_) => saved.push(arguments_),
        },
      },
    }),
    /Could not connect/,
  );

  assert.deepEqual(saved, []);
});

test('deletes only paths owned by an older manifest', async () => {
  const oldFiles = [
    localFile,
    { relativePath: 'obsolete.js', sha256: 'b'.repeat(64), size: 3 },
  ];
  const transport = new FakeTransport({
    manifest: Buffer.from(serializeManifest(createManifest(oldFiles))),
  });
  const changed = { ...localFile, sha256: 'c'.repeat(64) };

  const result = await runDeployment({
    configuration: configuration(),
    deleteRemote: true,
    yes: true,
    logger: silentLogger(),
    dependencies: deploymentDependencies(transport, [changed]),
  });

  assert.equal(result.uploaded, 1);
  assert.equal(result.deleted, 1);
  assert.deepEqual(transport.uploaded.map((item) => item.remotePath), ['/remote/index.html']);
  assert.deepEqual(transport.deleted, ['/remote/obsolete.js']);
  assert.equal(transport.buffers.length, 1);
  assert.equal(transport.replaced.length, 1);
});

test('does not advance the manifest when an upload fails', async () => {
  const transport = new FakeTransport({ failUpload: true });

  await assert.rejects(
    runDeployment({
      configuration: configuration(),
      yes: true,
      logger: silentLogger(),
      dependencies: deploymentDependencies(transport),
    }),
    /upload failed/,
  );

  assert.equal(transport.buffers.length, 0);
  assert.equal(transport.closed, 1);
});

test('falls back to a direct manifest write when atomic rename is unavailable', async () => {
  const transport = new FakeTransport({ failReplace: true });

  const result = await runDeployment({
    configuration: configuration(),
    yes: true,
    logger: silentLogger(),
    dependencies: deploymentDependencies(transport),
  });

  assert.equal(result.uploaded, 1);
  assert.equal(transport.buffers.length, 2);
  assert.match(transport.buffers[0].remotePath, /\.tmp-/);
  assert.equal(transport.buffers[1].remotePath, '/remote/.deploydo-manifest.json');
});

test('rejects deleting when manifest synchronization is disabled', async () => {
  await assert.rejects(
    runDeployment({
      configuration: configuration({ sync: { useManifest: false, manifestPath: '.deploydo-manifest.json' } }),
      deleteRemote: true,
      logger: silentLogger(),
      dependencies: deploymentDependencies(new FakeTransport()),
    }),
    UsageError,
  );
});

test('build failures stop before a remote connection is opened', async () => {
  const transport = new FakeTransport();

  await assert.rejects(
    runDeployment({
      configuration: configuration({ buildCommand: 'npm run build' }),
      yes: true,
      logger: silentLogger(),
      dependencies: {
        ...deploymentDependencies(transport),
        runBuild: async () => {
          throw new Error('build failed');
        },
      },
    }),
    /build failed/,
  );

  assert.equal(transport.connected, 0);
});
