import os from 'node:os';
import path from 'node:path';

import { ConfigError } from './errors.js';

// A non-dot filename also works on FTP servers that intentionally prohibit dot-file writes.
export const DEFAULT_MANIFEST_FILE = 'deploydo.manifest.json';

export function expandHomePath(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function resolveModernLocalPath(value, configDirectory) {
  return path.resolve(configDirectory, expandHomePath(value));
}

export function resolveLegacyLocalPath(value, cwd) {
  const expanded = expandHomePath(value);
  if (/^[A-Za-z]:[\\/]/.test(expanded) || expanded.startsWith('\\\\')) {
    return path.resolve(expanded);
  }

  // V2 documented a leading slash for a path relative to the working directory.
  return path.resolve(cwd, expanded.replace(/^[\\/]+/, ''));
}

export function toPosixRelativePath(value) {
  const normalized = value.replaceAll('\\', '/').split(path.sep).join('/').replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new ConfigError(`Invalid relative deployment path: ${value}`);
  }
  return normalized;
}

export function normalizeRemotePath(value) {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (!normalized || normalized === '.') {
    throw new ConfigError('remotePath must not be empty.');
  }
  return normalized === '/' ? normalized : normalized.replace(/\/$/, '');
}

export function remotePathFor(root, relativePath) {
  return path.posix.join(normalizeRemotePath(root), toPosixRelativePath(relativePath));
}

export function remoteParent(remotePath) {
  const parent = path.posix.dirname(remotePath);
  return parent === '.' ? '' : parent;
}

export function relativePathForDisplay(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}
