import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';

import { ConfigError } from './errors.js';
import { relativePathForDisplay, toPosixRelativePath } from './paths.js';

const internalExcludes = [
  '.deploydo-manifest.json',
  'deploydo.manifest.json',
  'deploy.cache.json',
  'deploy.pw.conf.json',
  'deploy.conf.json',
  'deploydo.config.json',
];

export async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function collectFiles({ sourceDirectory, exclude = [] }) {
  let sourceStat;
  try {
    sourceStat = await fs.stat(sourceDirectory);
  } catch (error) {
    throw new ConfigError(`sourcePath does not exist: ${sourceDirectory}`, { cause: error });
  }
  if (!sourceStat.isDirectory()) {
    throw new ConfigError(`sourcePath is not a directory: ${sourceDirectory}`);
  }

  const filePaths = await fg('**/*', {
    absolute: true,
    cwd: sourceDirectory,
    dot: true,
    followSymbolicLinks: false,
    ignore: [...internalExcludes, ...exclude],
    onlyFiles: true,
    unique: true,
  });

  const files = [];
  for (const filePath of filePaths.sort()) {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) continue;
    const relativePath = toPosixRelativePath(relativePathForDisplay(sourceDirectory, filePath));
    files.push({
      localPath: path.resolve(filePath),
      relativePath,
      sha256: await hashFile(filePath),
      size: stat.size,
    });
  }
  return files;
}
