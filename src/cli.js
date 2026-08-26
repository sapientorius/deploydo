import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';

import { Command } from 'commander';

import {
  DEFAULT_CONFIG_FILE,
  LEGACY_CONFIG_FILE,
  loadConfiguration,
  resolveConfigPath,
  writeModernConfig,
  writeSampleConfig,
} from './config.js';
import { systemPasswordStore } from './credential-store.js';
import { runDeployment } from './deploy.js';
import { DeploydoError, UsageError, getErrorMessage } from './errors.js';
import { createLogger } from './logger.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

function addConfigOptions(command, { includeProfile = true } = {}) {
  if (includeProfile) {
    command
      .option('-p, --profile <name>', 'profile to use')
      .option('--env <name>', 'legacy alias for --profile');
  }
  return command
    .option('-c, --config <file>', `configuration file (default: ${DEFAULT_CONFIG_FILE}, then ${LEGACY_CONFIG_FILE})`)
    .option('--deployConfigFile <file>', 'legacy alias for --config');
}

function profileNameFrom(options) {
  if (options.profile && options.env && options.profile !== options.env) {
    throw new UsageError('--profile and --env must name the same profile when both are set.');
  }
  return options.profile ?? options.env ?? 'default';
}

function configPathFrom(options) {
  if (options.config && options.deployConfigFile && options.config !== options.deployConfigFile) {
    throw new UsageError('--config and --deployConfigFile must name the same file when both are set.');
  }
  return options.config ?? options.deployConfigFile;
}

async function askForConfirmation(profile, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new UsageError('A non-interactive deployment requires --yes.');
  }
  const terminal = createInterface({ input, output });
  try {
    const answer = await terminal.question(`Deploy profile "${profile.name}" to ${profile.host}:${profile.remotePath}? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

function buildLogger(options, io) {
  return createLogger({
    json: Boolean(options.json),
    verbose: Boolean(options.verbose),
    stdout: io.stdout,
    stderr: io.stderr,
  });
}

async function loadForOptions(options, cwd) {
  return loadConfiguration({
    cwd,
    configPath: configPathFrom(options),
    profileName: profileNameFrom(options),
  });
}

function reportValidation(configuration, logger) {
  const result = {
    status: 'valid',
    profile: configuration.profileName,
    protocol: configuration.profile.protocol,
    configPath: configuration.configPath,
    legacy: configuration.legacy,
  };
  if (logger.json) logger.result(result);
  return result;
}

function normalizeArguments(argv) {
  const [nodePath, executablePath, ...args] = argv;
  const rootOnly = new Set(['--help', '-h', '--version', '-V']);
  if (args.some((argument) => rootOnly.has(argument))) return argv;
  if (args.includes('--sample')) {
    return [nodePath, executablePath, 'init', ...args.filter((argument) => argument !== '--sample')];
  }
  const commands = new Set(['deploy', 'validate', 'init', 'migrate', 'credentials', 'help']);
  if (args.length === 0 || args[0].startsWith('-') || !commands.has(args[0])) {
    return [nodePath, executablePath, 'deploy', ...args];
  }
  return argv;
}

function createProgram({ cwd, io, dependencies }) {
  const program = new Command();
  program
    .name('deploydo')
    .description('Deploy static files securely over SFTP, FTPS, or FTP')
    .version(version)
    .showHelpAfterError()
    .exitOverride();
  program.configureOutput({
    writeOut: (text) => io.stdout.write(text),
    writeErr: (text) => io.stderr.write(text),
  });

  addConfigOptions(program.command('deploy').description('build and deploy a profile'))
    .option('--dry-run', 'show the transfer plan without remote writes')
    .option('--delete', 'delete only files managed by a previous Deploydo manifest')
    .option('--yes', 'skip the interactive deployment confirmation')
    .option('--no-build', 'skip the configured build command')
    .option('--json', 'write the final result as JSON to stdout')
    .option('--non-interactive', 'fail instead of asking for terminal input')
    .option('--password-stdin', 'read the password once from standard input')
    .option('--save-password', 'save the entered password in the operating-system credential store after connecting')
    .option('--allow-legacy-password-file', 'temporarily allow deploy.pw.conf.json')
    .option('-v, --verbose', 'show individual file operations')
    .action(async (options) => {
      const configuration = await loadForOptions(options, cwd);
      const logger = buildLogger({ ...options, verbose: options.verbose || configuration.profile.verbose }, io);
      for (const warning of configuration.warnings) logger.warn(warning);
      const result = await runDeployment({
        configuration,
        dryRun: options.dryRun,
        deleteRemote: options.delete,
        runBuild: options.build,
        yes: options.yes,
        nonInteractive: options.nonInteractive,
        passwordFromStdin: options.passwordStdin,
        savePassword: options.savePassword,
        allowLegacyPasswordFile: options.allowLegacyPasswordFile,
        logger,
        confirm: (profile) => askForConfirmation(profile, io),
        environment: dependencies.environment,
        input: io.input,
        output: io.stderr,
        dependencies: {
          ...dependencies.deployment,
          ...(dependencies.passwordStore ? { passwordStore: dependencies.passwordStore } : {}),
        },
      });
      logger.result(result);
    });

  const credentials = program.command('credentials').description('manage passwords in the operating-system credential store');
  addConfigOptions(credentials.command('delete').description('delete the saved password for a profile'))
    .action(async (options) => {
      const configuration = await loadForOptions(options, cwd);
      const passwordStore = dependencies.passwordStore ?? systemPasswordStore;
      const removed = await passwordStore.remove(configuration.profile, {
        configPath: configuration.configPath,
        profileName: configuration.profileName,
      });
      if (removed) io.stdout.write(`Deleted saved password for profile "${configuration.profileName}".\n`);
      else io.stdout.write(`No saved password found for profile "${configuration.profileName}".\n`);
    });

  addConfigOptions(program.command('validate').description('validate a profile configuration'))
    .option('--json', 'write the result as JSON to stdout')
    .action(async (options) => {
      const logger = buildLogger(options, io);
      const configuration = await loadForOptions(options, cwd);
      for (const warning of configuration.warnings) logger.warn(warning);
      const result = reportValidation(configuration, logger);
      if (!options.json) io.stdout.write(`Configuration is valid for profile "${result.profile}" (${result.protocol}).\n`);
    });

  program.command('init').description(`write a ${DEFAULT_CONFIG_FILE} template`)
    .option('-o, --output <file>', 'destination file')
    .option('--force', 'overwrite an existing destination file')
    .action(async (options) => {
      const destination = await writeSampleConfig({ cwd, destinationPath: options.output, force: options.force });
      io.stdout.write(`Created ${destination}. Configure credentials with environment variables or an SSH key.\n`);
    });

  addConfigOptions(program.command('migrate').description(`migrate ${LEGACY_CONFIG_FILE} to ${DEFAULT_CONFIG_FILE}`), { includeProfile: false })
    .option('-o, --output <file>', `destination file (default: ${DEFAULT_CONFIG_FILE})`)
    .option('--force', 'overwrite an existing destination file')
    .action(async (options) => {
      const source = await resolveConfigPath({ cwd, configPath: configPathFrom(options) });
      const destination = await writeModernConfig({
        sourcePath: source,
        destinationPath: options.output ?? DEFAULT_CONFIG_FILE,
        cwd,
        force: options.force,
      });
      io.stdout.write(`Migrated ${path.basename(source)} to ${destination}. No passwords were copied.\n`);
    });

  return program;
}

export async function runCli(argv = process.argv, {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  input = process.stdin,
  environment = process.env,
  deployment = {},
  passwordStore,
} = {}) {
  const io = { stdout, stderr, input };
  try {
    const program = createProgram({ cwd, io, dependencies: { environment, deployment, passwordStore } });
    await program.parseAsync(normalizeArguments(argv), { from: 'node' });
    return 0;
  } catch (error) {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return 0;
    const exitCode = error instanceof DeploydoError
      ? error.exitCode
      : (String(error.code ?? '').startsWith('commander.') ? 2 : 1);
    stderr.write(`Error: ${getErrorMessage(error)}\n`);
    return exitCode;
  }
}
