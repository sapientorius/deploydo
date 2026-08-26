import assert from 'node:assert/strict';
import test from 'node:test';

import { createSystemPasswordStore, passwordStoreAccount } from '../src/credential-store.js';

const profile = {
  name: 'production',
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  configDirectory: '/projects/site',
};

test('uses a distinct, non-secret account for each deployment target', () => {
  const account = passwordStoreAccount(profile, { configPath: '/projects/site/deploydo.config.json' });
  const changedHost = passwordStoreAccount({ ...profile, host: 'other.example.com' }, { configPath: '/projects/site/deploydo.config.json' });

  assert.match(account, /^profile:production:[A-Za-z0-9_-]+$/);
  assert.notEqual(account, changedHost);
  assert.doesNotMatch(account, /example\.com|deploy/);
});

test('reads, saves, and deletes passwords through the system-store adapter', async () => {
  const entries = new Map();
  class FakeEntry {
    constructor(service, account) {
      this.key = `${service}:${account}`;
    }

    getPassword() {
      return entries.get(this.key) ?? null;
    }

    setPassword(password) {
      entries.set(this.key, password);
    }

    deleteCredential() {
      return entries.delete(this.key);
    }
  }
  const store = createSystemPasswordStore({ EntryClass: FakeEntry });

  assert.equal(await store.get(profile), null);
  await store.save(profile, 'secret');
  assert.equal(await store.get(profile), 'secret');
  assert.equal(await store.remove(profile), true);
  assert.equal(await store.remove(profile), false);
});
