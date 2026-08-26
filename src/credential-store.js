import { createHash } from 'node:crypto';

import { Entry } from '@napi-rs/keyring';

import { AuthenticationError } from './errors.js';

export const PASSWORD_STORE_SERVICE = 'deploydo';

function storeUnavailable(error) {
  return new AuthenticationError(
    'The operating-system credential store is unavailable. Check that it is unlocked and available.',
    { cause: error },
  );
}

export function passwordStoreAccount(profile, { configPath, profileName = profile.name } = {}) {
  const identifier = JSON.stringify({
    configPath: configPath ?? profile.configDirectory,
    profileName,
    protocol: profile.protocol,
    host: profile.host,
    port: profile.port,
    username: profile.username,
  });
  const digest = createHash('sha256').update(identifier).digest('base64url');
  return `profile:${profileName}:${digest}`;
}

export function createSystemPasswordStore({ EntryClass = Entry } = {}) {
  function entryFor(profile, options) {
    return new EntryClass(PASSWORD_STORE_SERVICE, passwordStoreAccount(profile, options));
  }

  return {
    async get(profile, options) {
      try {
        return entryFor(profile, options).getPassword();
      } catch (error) {
        throw storeUnavailable(error);
      }
    },

    async save(profile, password, options) {
      try {
        entryFor(profile, options).setPassword(password);
      } catch (error) {
        throw storeUnavailable(error);
      }
    },

    async remove(profile, options) {
      try {
        return entryFor(profile, options).deleteCredential();
      } catch (error) {
        throw storeUnavailable(error);
      }
    },
  };
}

export const systemPasswordStore = createSystemPasswordStore();
