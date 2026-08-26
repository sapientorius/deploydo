import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { ConfigError } from './errors.js';
import { normalizeSshSha256Fingerprint } from './fingerprint.js';
import { DEFAULT_MANIFEST_FILE, normalizeRemotePath, resolveLegacyLocalPath, resolveModernLocalPath, toPosixRelativePath } from './paths.js';

export const DEFAULT_CONFIG_FILE = 'deploydo.config.json';
export const LEGACY_CONFIG_FILE = 'deploy.conf.json';

const stringArray = z.array(z.string().min(1));
const excludeSchema = z.union([z.string().min(1), stringArray]).optional();
const authSchema = z.object({
  passwordEnv: z.string().min(1).optional(),
  privateKeyPath: z.string().min(1).optional(),
  privateKeyPassphraseEnv: z.string().min(1).optional(),
  hostFingerprint: z.string().min(1).optional(),
}).strict();
const buildSchema = z.object({
  command: z.string().min(1),
}).strict();
const syncSchema = z.object({
  useManifest: z.boolean().optional(),
  manifestPath: z.string().min(1).optional(),
}).strict();
const connectionSchema = z.object({
  retries: z.coerce.number().int().min(0).max(5).optional(),
}).strict();
const ftpsSchema = z.object({
  mode: z.enum(['explicit', 'implicit']).optional(),
  rejectUnauthorized: z.boolean().optional(),
}).strict();
const profileSchema = z.object({
  protocol: z.enum(['sftp', 'ftp', 'ftps']),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  username: z.string().min(1),
  sourcePath: z.string().min(1),
  remotePath: z.string().min(1),
  exclude: excludeSchema,
  verbose: z.boolean().optional(),
  build: buildSchema.optional(),
  auth: authSchema.optional(),
  sync: syncSchema.optional(),
  connection: connectionSchema.optional(),
  ftps: ftpsSchema.optional(),
}).strict();
const modernConfigSchema = z.object({
  profiles: z.record(z.string().min(1), profileSchema),
}).strict();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function zodErrorMessage(error) {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
    .join('; ');
}

function normalizeExcludes(value) {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

function defaultPort(protocol, ftps) {
  if (protocol === 'sftp') return 22;
  if (protocol === 'ftps' && ftps?.mode === 'implicit') return 990;
  return 21;
}

function validateProfileSemantics(profile, name) {
  if (profile.protocol !== 'sftp' && profile.auth?.privateKeyPath) {
    throw new ConfigError(`Profile "${name}" uses privateKeyPath, which is only supported by SFTP.`);
  }
  if (profile.protocol !== 'sftp' && profile.auth?.hostFingerprint) {
    throw new ConfigError(`Profile "${name}" uses hostFingerprint, which is only supported by SFTP.`);
  }
  if (profile.protocol !== 'ftps' && profile.ftps) {
    throw new ConfigError(`Profile "${name}" defines FTPS settings but does not use protocol "ftps".`);
  }
  if (profile.auth?.hostFingerprint) {
    try {
      normalizeSshSha256Fingerprint(profile.auth.hostFingerprint);
    } catch (error) {
      throw new ConfigError(`Profile "${name}" has an invalid hostFingerprint: ${error.message}`);
    }
  }
}

function normalizeProfile(name, rawProfile, { legacy, cwd, configDirectory }) {
  let parsed;
  try {
    parsed = profileSchema.parse(rawProfile);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ConfigError(`Invalid profile "${name}": ${zodErrorMessage(error)}`);
    }
    throw error;
  }

  validateProfileSemantics(parsed, name);
  const sourceDirectory = legacy
    ? resolveLegacyLocalPath(parsed.sourcePath, cwd)
    : resolveModernLocalPath(parsed.sourcePath, configDirectory);
  const ftps = {
    mode: parsed.ftps?.mode ?? 'explicit',
    rejectUnauthorized: parsed.ftps?.rejectUnauthorized ?? true,
  };

  return {
    ...parsed,
    name,
    configDirectory,
    sourceDirectory,
    remotePath: normalizeRemotePath(parsed.remotePath),
    port: parsed.port ?? defaultPort(parsed.protocol, ftps),
    exclude: normalizeExcludes(parsed.exclude),
    verbose: parsed.verbose ?? false,
    buildCommand: parsed.build?.command,
    auth: parsed.auth ?? {},
    sync: {
      useManifest: parsed.sync?.useManifest ?? true,
      manifestPath: toPosixRelativePath(parsed.sync?.manifestPath ?? DEFAULT_MANIFEST_FILE),
    },
    connection: {
      retries: parsed.connection?.retries ?? 2,
    },
    ftps,
  };
}

function legacyProfileToModern(value, name) {
  if (!isPlainObject(value)) {
    throw new ConfigError(`Legacy profile "${name}" must be an object.`);
  }
  if (Object.hasOwn(value, 'pass')) {
    throw new ConfigError(`Legacy profile "${name}" contains a password. Remove it and use passwordEnv or --password-stdin.`);
  }

  return {
    protocol: value.type,
    host: value.host,
    port: value.port,
    username: value.user,
    sourcePath: value.sourcePath,
    remotePath: value.remotePath,
    exclude: value.ignore ?? undefined,
    verbose: value.verbose,
    build: value.buildCommand ? { command: value.buildCommand } : undefined,
    sync: { useManifest: value.useCache !== false },
  };
}

function sourcePathForMigration(value) {
  if (typeof value !== 'string') return value;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return value;
  return value.replace(/^[\\/]+/, '') || '.';
}

export function legacyDocumentToModernDocument(document) {
  if (!isPlainObject(document)) {
    throw new ConfigError('Legacy configuration must be an object whose keys are profile names.');
  }

  const profiles = {};
  for (const [name, value] of Object.entries(document)) {
    const converted = legacyProfileToModern(value, name);
    profiles[name] = {
      protocol: converted.protocol,
      host: converted.host,
      ...(converted.port === undefined ? {} : { port: converted.port }),
      username: converted.username,
      sourcePath: sourcePathForMigration(converted.sourcePath),
      remotePath: converted.remotePath,
      ...(converted.exclude === undefined || converted.exclude === null ? {} : { exclude: converted.exclude }),
      ...(converted.verbose === undefined ? {} : { verbose: converted.verbose }),
      ...(converted.build === undefined ? {} : { build: converted.build }),
      sync: converted.sync,
      auth: {},
    };
  }
  return { profiles };
}

export async function resolveConfigPath({ cwd = process.cwd(), configPath } = {}) {
  if (configPath) return path.resolve(cwd, configPath);

  for (const candidate of [DEFAULT_CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    const candidatePath = path.join(cwd, candidate);
    try {
      await fs.access(candidatePath);
      return candidatePath;
    } catch {
      // Try the next candidate.
    }
  }
  throw new ConfigError(`No configuration found. Create ${DEFAULT_CONFIG_FILE} or pass --config <file>.`);
}

export async function readJsonFile(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new ConfigError(`Configuration file not found: ${filePath}`);
    throw new ConfigError(`Could not read configuration file ${filePath}: ${error.message}`, { cause: error });
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${filePath}: ${error.message}`, { cause: error });
  }
}

function isModernDocument(document) {
  return isPlainObject(document) && Object.hasOwn(document, 'profiles');
}

function selectProfile(profiles, profileName) {
  if (!Object.hasOwn(profiles, profileName)) {
    const available = Object.keys(profiles).sort();
    throw new ConfigError(`Profile "${profileName}" was not found. Available profiles: ${available.join(', ') || '(none)'}.`);
  }
  return profiles[profileName];
}

export async function loadConfiguration({ cwd = process.cwd(), configPath, profileName = 'default' } = {}) {
  const resolvedPath = await resolveConfigPath({ cwd, configPath });
  const document = await readJsonFile(resolvedPath);
  const configDirectory = path.dirname(resolvedPath);
  const legacy = !isModernDocument(document);
  let profileDocuments;

  if (legacy) {
    if (!isPlainObject(document)) {
      throw new ConfigError('Legacy configuration must be an object whose keys are profile names.');
    }
    profileDocuments = Object.fromEntries(
      Object.entries(document).map(([name, value]) => [name, legacyProfileToModern(value, name)]),
    );
  } else {
    try {
      profileDocuments = modernConfigSchema.parse(document).profiles;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ConfigError(`Invalid configuration: ${zodErrorMessage(error)}`);
      }
      throw error;
    }
  }

  const normalizedProfiles = Object.fromEntries(
    Object.entries(profileDocuments).map(([name, value]) => [name, normalizeProfile(name, value, { legacy, cwd, configDirectory })]),
  );
  return {
    configPath: resolvedPath,
    configDirectory,
    cwd,
    document,
    legacy,
    profileName,
    profile: selectProfile(normalizedProfiles, profileName),
    warnings: legacy ? [`${path.basename(resolvedPath)} uses the legacy V2 format. Run deploydo migrate to create ${DEFAULT_CONFIG_FILE}.`] : [],
  };
}

export async function writeModernConfig({ sourcePath, destinationPath, cwd = process.cwd(), force = false } = {}) {
  const sourceDocument = await readJsonFile(sourcePath);
  if (isModernDocument(sourceDocument)) {
    throw new ConfigError(`${sourcePath} is already a V3 configuration.`);
  }
  const target = path.resolve(cwd, destinationPath ?? DEFAULT_CONFIG_FILE);
  try {
    await fs.access(target);
    if (!force) throw new ConfigError(`Refusing to overwrite existing file: ${target}. Pass --force to overwrite it.`);
  } catch (error) {
    if (!(error instanceof ConfigError) && error?.code !== 'ENOENT') throw error;
    if (error instanceof ConfigError) throw error;
  }

  const output = legacyDocumentToModernDocument(sourceDocument);
  try {
    modernConfigSchema.parse(output);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ConfigError(`Cannot migrate invalid legacy configuration: ${zodErrorMessage(error)}`);
    }
    throw error;
  }
  await fs.writeFile(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return target;
}

export function createSampleConfig() {
  return {
    profiles: {
      default: {
        protocol: 'sftp',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        sourcePath: 'dist',
        remotePath: '/var/www/html',
        exclude: ['**/*.map'],
        build: { command: 'npm run build' },
        auth: {
          passwordEnv: 'DEPLOYDO_PASSWORD',
        },
        sync: { useManifest: true },
      },
    },
  };
}

export async function writeSampleConfig({ cwd = process.cwd(), destinationPath = DEFAULT_CONFIG_FILE, force = false } = {}) {
  const target = path.resolve(cwd, destinationPath);
  try {
    await fs.access(target);
    if (!force) throw new ConfigError(`Refusing to overwrite existing file: ${target}. Pass --force to overwrite it.`);
  } catch (error) {
    if (!(error instanceof ConfigError) && error?.code !== 'ENOENT') throw error;
    if (error instanceof ConfigError) throw error;
  }
  await fs.writeFile(target, `${JSON.stringify(createSampleConfig(), null, 2)}\n`, 'utf8');
  return target;
}
