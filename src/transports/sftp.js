import SftpClient from 'ssh2-sftp-client';
import path from 'node:path';

import { DeploydoError } from '../errors.js';
import { normalizeSshSha256Fingerprint } from '../fingerprint.js';
import { remoteParent } from '../paths.js';
import { isNotFoundError } from './utils.js';

export class SftpTransport {
  constructor(profile, logger) {
    this.profile = profile;
    this.logger = logger;
    this.client = undefined;
  }

  async connect(credentials) {
    this.client = new SftpClient('deploydo', {
      error: (error) => this.logger.debug(`SFTP client error: ${error.message}`),
      end: () => {},
      close: () => {},
    });
    const fingerprint = this.profile.auth.hostFingerprint;
    const expectedFingerprint = fingerprint ? normalizeSshSha256Fingerprint(fingerprint) : undefined;
    if (!fingerprint) {
      this.logger.warn(`SFTP profile "${this.profile.name}" has no hostFingerprint; the server identity is not pinned.`);
    }

    await this.client.connect({
      host: this.profile.host,
      port: this.profile.port,
      username: this.profile.username,
      ...credentials,
      ...(fingerprint ? {
        hostHash: 'sha256',
        hostVerifier: (received) => String(received).toLowerCase() === expectedFingerprint,
      } : {}),
    });
  }

  async download(remotePath) {
    try {
      const result = await this.client.get(remotePath);
      return Buffer.isBuffer(result) ? result : Buffer.from(result);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw new DeploydoError(`Could not download ${remotePath}: ${error.message}`, { cause: error });
    }
  }

  async ensureDirectory(remoteDirectory) {
    if (!remoteDirectory || remoteDirectory === '/') return;
    const absolute = remoteDirectory.startsWith('/');
    let current = absolute ? '/' : '';
    for (const segment of remoteDirectory.split('/').filter(Boolean)) {
      current = current ? path.posix.join(current, segment) : segment;
      const exists = await this.client.exists(current);
      if (exists === 'd') continue;
      if (exists) throw new DeploydoError(`Remote path is not a directory: ${current}`);
      await this.client.mkdir(current);
    }
  }

  async uploadFile(localPath, remotePath) {
    await this.ensureDirectory(remoteParent(remotePath));
    await this.client.put(localPath, remotePath);
  }

  async uploadBuffer(content, remotePath) {
    await this.ensureDirectory(remoteParent(remotePath));
    await this.client.put(content, remotePath);
  }

  async remove(remotePath) {
    try {
      await this.client.delete(remotePath);
    } catch (error) {
      if (!isNotFoundError(error)) throw new DeploydoError(`Could not delete ${remotePath}: ${error.message}`, { cause: error });
    }
  }

  async rename(fromPath, toPath) {
    await this.client.rename(fromPath, toPath);
  }

  async replace(fromPath, toPath) {
    try {
      await this.client.posixRename(fromPath, toPath);
    } catch (posixError) {
      this.logger.debug(`SFTP POSIX rename is unavailable (${posixError.message}); using a compatibility rename.`);
      await this.rename(fromPath, toPath);
    }
  }

  async close() {
    if (this.client) await this.client.end();
    this.client = undefined;
  }
}
