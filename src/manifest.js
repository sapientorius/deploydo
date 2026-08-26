import { ConfigError } from './errors.js';
import { toPosixRelativePath } from './paths.js';

export const MANIFEST_VERSION = 1;

function isManifestFile(value) {
  return value
    && typeof value === 'object'
    && typeof value.sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(value.sha256)
    && Number.isInteger(value.size)
    && value.size >= 0;
}

export function emptyManifest() {
  return { version: MANIFEST_VERSION, files: {} };
}

export function parseManifest(content) {
  if (!content) return { manifest: emptyManifest(), valid: false };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(content) ? content.toString('utf8') : content);
  } catch {
    return { manifest: emptyManifest(), valid: false };
  }
  if (parsed?.version !== MANIFEST_VERSION || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    return { manifest: emptyManifest(), valid: false };
  }
  try {
    for (const [filePath, value] of Object.entries(parsed.files)) {
      toPosixRelativePath(filePath);
      if (!isManifestFile(value)) throw new ConfigError('Invalid manifest file entry.');
    }
  } catch {
    return { manifest: emptyManifest(), valid: false };
  }
  return { manifest: parsed, valid: true };
}

export function createManifest(files) {
  return {
    version: MANIFEST_VERSION,
    files: Object.fromEntries(files.map((file) => [file.relativePath, {
      sha256: file.sha256,
      size: file.size,
    }])),
  };
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function createSyncPlan(files, manifest, { deleteRemote = false, useManifest = true } = {}) {
  const previous = useManifest ? manifest.files : {};
  const current = new Map(files.map((file) => [file.relativePath, file]));
  const uploads = [];
  const skipped = [];

  for (const file of files) {
    const previousFile = previous[file.relativePath];
    if (previousFile?.sha256 === file.sha256 && previousFile.size === file.size) skipped.push(file);
    else uploads.push(file);
  }

  const deletions = deleteRemote && useManifest
    ? Object.keys(previous).filter((filePath) => !current.has(filePath)).sort()
    : [];

  return { uploads, skipped, deletions };
}
