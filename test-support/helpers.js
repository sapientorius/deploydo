import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

export async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deploydo-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function outputCapture() {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

export function silentLogger() {
  return {
    debug() {},
    error() {},
    info() {},
    warn() {},
    commandOutput() {},
  };
}
