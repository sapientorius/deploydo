export function createLogger({ json = false, verbose = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  const write = (stream, message) => stream.write(`${message}\n`);
  return {
    json,
    info(message) {
      if (!json) write(stdout, message);
    },
    warn(message) {
      write(stderr, `Warning: ${message}`);
    },
    error(message) {
      write(stderr, `Error: ${message}`);
    },
    debug(message) {
      if (verbose && !json) write(stdout, message);
    },
    commandOutput(message) {
      write(json ? stderr : stdout, message);
    },
    result(value) {
      if (json) write(stdout, JSON.stringify(value));
      else if (value.status === 'dry-run') {
        write(stdout, `Dry run: ${value.plannedUploads} upload, ${value.skipped} unchanged, ${value.plannedDeletions} delete.`);
      } else {
        write(stdout, `Deployment complete: ${value.uploaded} uploaded, ${value.skipped} unchanged, ${value.deleted} deleted.`);
      }
    },
  };
}
