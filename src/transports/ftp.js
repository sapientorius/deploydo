import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import * as basicFtp from 'basic-ftp';

import { DeploydoError } from '../errors.js';
import { isNotFoundError } from './utils.js';

function bufferSink(chunks) {
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
}

function pathParts(remotePath) {
  const normalized = remotePath.replaceAll('\\', '/');
  const directory = path.posix.dirname(normalized);
  return {
    directory: directory === '.' || directory === '/' ? '' : directory.replace(/^\/+/, ''),
    fileName: path.posix.basename(normalized),
  };
}

export class FtpTransport {
  constructor(profile, logger) {
    this.profile = profile;
    this.logger = logger;
    this.client = undefined;
  }

  async connect(credentials) {
    this.client = new basicFtp.Client(30_000);
    this.client.ftp.verbose = false;
    const secure = this.profile.protocol === 'ftps'
      ? (this.profile.ftps.mode === 'implicit' ? 'implicit' : true)
      : false;
    await this.client.access({
      host: this.profile.host,
      port: this.profile.port,
      user: this.profile.username,
      password: credentials.password,
      secure,
      ...(secure ? { secureOptions: { rejectUnauthorized: this.profile.ftps.rejectUnauthorized } } : {}),
    });
  }

  async download(remotePath) {
    const chunks = [];
    try {
      const { directory, fileName } = pathParts(remotePath);
      await this.changeDirectory(directory);
      await this.client.downloadTo(bufferSink(chunks), fileName);
      return Buffer.concat(chunks);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw new DeploydoError(`Could not download ${remotePath}: ${error.message}`, { cause: error });
    }
  }

  async ensureDirectory(remoteDirectory) {
    const { directory } = pathParts(`${remoteDirectory || ''}/placeholder`);
    await this.client.ensureDir(`/${directory}`);
  }

  async changeDirectory(directory) {
    await this.client.cd('/');
    for (const part of directory.split('/').filter(Boolean)) {
      await this.client.cd(part);
    }
  }

  async uploadFile(localPath, remotePath) {
    const { directory, fileName } = pathParts(remotePath);
    await this.ensureDirectory(directory);
    await this.client.uploadFrom(localPath, fileName);
  }

  async uploadBuffer(content, remotePath) {
    const { directory, fileName } = pathParts(remotePath);
    await this.ensureDirectory(directory);
    await this.client.uploadFrom(Readable.from([content]), fileName);
  }

  async remove(remotePath) {
    try {
      const { directory, fileName } = pathParts(remotePath);
      await this.changeDirectory(directory);
      await this.client.remove(fileName);
    } catch (error) {
      if (!isNotFoundError(error)) throw new DeploydoError(`Could not delete ${remotePath}: ${error.message}`, { cause: error });
    }
  }

  async rename(fromPath, toPath) {
    const from = pathParts(fromPath);
    const to = pathParts(toPath);
    await this.changeDirectory(from.directory);
    const target = from.directory === to.directory ? to.fileName : toPath.replace(/^\/+/, '');
    await this.client.rename(from.fileName, target);
  }

  async replace(fromPath, toPath) {
    await this.rename(fromPath, toPath);
  }

  async close() {
    this.client?.close();
    this.client = undefined;
  }
}
