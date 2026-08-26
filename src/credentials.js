import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { systemPasswordStore } from './credential-store.js';
import { AuthenticationError, ConfigError } from './errors.js';
import { expandHomePath } from './paths.js';

function isInteractive(input, output) {
  return Boolean(input?.isTTY && output?.isTTY);
}

export async function readPasswordFromStdin(input = process.stdin) {
  const chunks = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  const password = Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
  if (!password) throw new AuthenticationError('--password-stdin did not receive a password.');
  return password;
}

export function promptForSecret({ input = process.stdin, output = process.stderr, prompt = 'Password: ' } = {}) {
  if (!isInteractive(input, output)) {
    return Promise.reject(new AuthenticationError('No password source is configured and no interactive terminal is available.'));
  }

  return new Promise((resolve) => {
    const terminal = readline.createInterface({ input, output, terminal: true });
    const write = terminal._writeToOutput.bind(terminal);
    let muted = false;
    terminal._writeToOutput = (value) => {
      if (muted && value !== '\n' && value !== '\r\n') output.write('*');
      else write(value);
    };
    terminal.question(prompt, (answer) => {
      muted = false;
      output.write('\n');
      terminal.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function readEnvironmentSecret(name, environment) {
  const value = environment[name];
  if (!value) throw new AuthenticationError(`Environment variable ${name} is not set or empty.`);
  return value;
}

async function readLegacyPassword({ legacyPasswordPath, profileName }) {
  let raw;
  try {
    raw = await fs.readFile(legacyPasswordPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new AuthenticationError(`Legacy password file not found: ${legacyPasswordPath}`);
    }
    throw new AuthenticationError(`Could not read legacy password file: ${error.message}`, { cause: error });
  }

  let values;
  try {
    values = JSON.parse(raw);
  } catch (error) {
    throw new AuthenticationError(`Legacy password file is not valid JSON: ${error.message}`, { cause: error });
  }
  const password = values?.[profileName];
  if (typeof password !== 'string' || !password) {
    throw new AuthenticationError(`Legacy password file has no password for profile "${profileName}".`);
  }
  return password;
}

export async function resolveCredentials(profile, {
  allowLegacyPasswordFile = false,
  environment = process.env,
  input = process.stdin,
  output = process.stderr,
  passwordFromStdin = false,
  forcePasswordPrompt = false,
  passwordStore = systemPasswordStore,
  promptPassword = promptForSecret,
  configPath,
  legacyPasswordPath,
  profileName = profile.name,
} = {}) {
  const auth = profile.auth ?? {};
  const credentials = {};

  if (auth.privateKeyPath) {
    const privateKeyPath = path.resolve(profile.configDirectory, expandHomePath(auth.privateKeyPath));
    try {
      credentials.privateKey = await fs.readFile(privateKeyPath);
    } catch (error) {
      throw new ConfigError(`Could not read privateKeyPath for profile "${profile.name}": ${error.message}`, { cause: error });
    }
    if (auth.privateKeyPassphraseEnv) {
      credentials.passphrase = await readEnvironmentSecret(auth.privateKeyPassphraseEnv, environment);
    }
  }

  if (passwordFromStdin) {
    credentials.password = await readPasswordFromStdin(input);
  } else if (forcePasswordPrompt) {
    credentials.password = await promptPassword({ input, output });
    if (!credentials.password) throw new AuthenticationError('An empty password is not allowed.');
  } else if (auth.passwordEnv && Object.hasOwn(environment, auth.passwordEnv)) {
    credentials.password = await readEnvironmentSecret(auth.passwordEnv, environment);
  } else if (allowLegacyPasswordFile) {
    credentials.password = await readLegacyPassword({ legacyPasswordPath, profileName });
  } else if (!credentials.privateKey) {
    credentials.password = await passwordStore.get(profile, { configPath, profileName });
    if (!credentials.password) credentials.password = await promptPassword({ input, output });
    if (!credentials.password) throw new AuthenticationError('An empty password is not allowed.');
  }

  return credentials;
}
