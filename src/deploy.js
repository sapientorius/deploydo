import path from 'node:path';

import { runBuild } from './build.js';
import { systemPasswordStore } from './credential-store.js';
import { resolveCredentials } from './credentials.js';
import { DeploydoError, UsageError } from './errors.js';
import { collectFiles } from './files.js';
import { createManifest, createSyncPlan, parseManifest, serializeManifest } from './manifest.js';
import { remotePathFor } from './paths.js';
import { createTransport } from './transports/index.js';
import { isAuthenticationError } from './transports/utils.js';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connectWithRetries({ profile, credentials, logger, transportFactory }) {
  let lastError;
  for (let attempt = 0; attempt <= profile.connection.retries; attempt += 1) {
    const transport = transportFactory(profile, logger);
    try {
      await transport.connect(credentials);
      return transport;
    } catch (error) {
      lastError = error;
      await transport.close().catch(() => {});
      if (isAuthenticationError(error) || attempt === profile.connection.retries) break;
      logger.warn(`Connection attempt ${attempt + 1} failed: ${error.message}. Retrying...`);
      await wait(150 * (attempt + 1));
    }
  }
  throw new DeploydoError(`Could not connect to ${profile.host}: ${lastError?.message ?? 'unknown connection error'}`, { cause: lastError });
}

async function writeManifest(transport, manifestPath, manifest, logger) {
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  const content = Buffer.from(serializeManifest(manifest), 'utf8');
  try {
    await transport.uploadBuffer(content, temporaryPath);
    try {
      await transport.replace(temporaryPath, manifestPath);
    } catch (error) {
      logger.warn(`Atomic manifest replacement is unavailable on this server (${error.message}); updating the manifest directly.`);
      await transport.uploadBuffer(content, manifestPath);
      await transport.remove(temporaryPath);
    }
  } catch (error) {
    await transport.remove(temporaryPath).catch(() => {});
    throw new DeploydoError(`Could not update remote manifest: ${error.message}`, { cause: error });
  }
}

function summarizePlan({ configuration, plan, dryRun, manifestValid }) {
  return {
    status: dryRun ? 'dry-run' : 'success',
    profile: configuration.profileName,
    protocol: configuration.profile.protocol,
    uploaded: dryRun ? 0 : plan.uploads.length,
    plannedUploads: plan.uploads.length,
    skipped: plan.skipped.length,
    deleted: dryRun ? 0 : plan.deletions.length,
    plannedDeletions: plan.deletions.length,
    manifestValid,
  };
}

export async function runDeployment({
  configuration,
  dryRun = false,
  deleteRemote = false,
  runBuild: shouldRunBuild = true,
  yes = false,
  nonInteractive = false,
  passwordFromStdin = false,
  savePassword = false,
  allowLegacyPasswordFile = false,
  logger,
  confirm,
  environment = process.env,
  input = process.stdin,
  output = process.stderr,
  dependencies = {},
}) {
  const profile = configuration.profile;
  const fileCollector = dependencies.collectFiles ?? collectFiles;
  const credentialResolver = dependencies.resolveCredentials ?? resolveCredentials;
  const passwordStore = dependencies.passwordStore ?? systemPasswordStore;
  const buildRunner = dependencies.runBuild ?? runBuild;
  const transportFactory = dependencies.createTransport ?? createTransport;

  if (deleteRemote && !profile.sync.useManifest) {
    throw new UsageError('--delete requires sync.useManifest to be enabled.');
  }
  if (passwordFromStdin && !dryRun && !yes) {
    throw new UsageError('--password-stdin requires --yes for a non-interactive deploy.');
  }
  if (!dryRun && !yes) {
    if (nonInteractive || !confirm) {
      throw new UsageError('Non-interactive deployments require --yes.');
    }
    const accepted = await confirm(profile);
    if (!accepted) throw new DeploydoError('Deployment cancelled by user.', { code: 'CANCELLED', exitCode: 130 });
  }

  if (profile.protocol === 'ftp') {
    logger.warn('FTP sends deployment data and credentials without transport encryption. Prefer SFTP or FTPS.');
  }
  if (!dryRun && shouldRunBuild && profile.buildCommand) {
    logger.info(`Running build command: ${profile.buildCommand}`);
    const buildCwd = configuration.legacy ? configuration.cwd : configuration.configDirectory;
    await buildRunner(profile.buildCommand, { cwd: buildCwd, logger, environment });
  }

  const files = await fileCollector({ sourceDirectory: profile.sourceDirectory, exclude: profile.exclude });
  const legacyPasswordPath = path.join(configuration.cwd, 'deploy.pw.conf.json');
  const credentials = await credentialResolver(profile, {
    allowLegacyPasswordFile,
    environment,
    input,
    output,
    passwordFromStdin,
    forcePasswordPrompt: savePassword,
    passwordStore,
    configPath: configuration.configPath,
    legacyPasswordPath,
    profileName: configuration.profileName,
    promptPassword: nonInteractive
      ? () => Promise.reject(new DeploydoError('No non-interactive password source is configured.'))
      : undefined,
  });

  let transport;
  try {
    transport = await connectWithRetries({ profile, credentials, logger, transportFactory });
    if (savePassword) {
      await passwordStore.save(profile, credentials.password, {
        configPath: configuration.configPath,
        profileName: configuration.profileName,
      });
      logger.info('Password saved in the operating-system credential store.');
    }
    const manifestPath = remotePathFor(profile.remotePath, profile.sync.manifestPath);
    const manifestContent = profile.sync.useManifest ? await transport.download(manifestPath) : null;
    const parsedManifest = parseManifest(manifestContent);
    if (manifestContent && !parsedManifest.valid) {
      logger.warn('Remote manifest is invalid; treating every local file as changed and disabling deletions for this run.');
    }
    const plan = createSyncPlan(files, parsedManifest.manifest, {
      deleteRemote: deleteRemote && parsedManifest.valid,
      useManifest: profile.sync.useManifest,
    });
    logger.info(`Plan: ${plan.uploads.length} upload, ${plan.skipped.length} unchanged, ${plan.deletions.length} delete.`);

    if (dryRun) return summarizePlan({ configuration, plan, dryRun, manifestValid: parsedManifest.valid });

    for (const file of plan.uploads) {
      logger.debug(`Uploading ${file.relativePath}`);
      await transport.uploadFile(file.localPath, remotePathFor(profile.remotePath, file.relativePath));
    }
    for (const filePath of plan.deletions) {
      logger.debug(`Deleting ${filePath}`);
      await transport.remove(remotePathFor(profile.remotePath, filePath));
    }
    if (profile.sync.useManifest) {
      await writeManifest(transport, manifestPath, createManifest(files), logger);
    }
    return summarizePlan({ configuration, plan, dryRun, manifestValid: parsedManifest.valid });
  } finally {
    await transport?.close().catch((error) => logger.debug(`Could not close transfer connection cleanly: ${error.message}`));
  }
}
