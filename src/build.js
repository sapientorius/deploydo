import { spawn } from 'node:child_process';

import { DeploydoError } from './errors.js';

export function runBuild(command, { cwd, logger, environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: environment,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (data) => logger.commandOutput(data.toString().replace(/\r?\n$/, '')));
    child.stderr.on('data', (data) => logger.commandOutput(data.toString().replace(/\r?\n$/, '')));
    child.on('error', (error) => reject(new DeploydoError(`Could not start build command: ${error.message}`, { cause: error })));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new DeploydoError(`Build command failed${signal ? ` (${signal})` : ` with exit code ${code}`}.`));
    });
  });
}
