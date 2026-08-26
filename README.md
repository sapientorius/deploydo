# deploydo

Deploy static files over SFTP, FTPS, or FTP from a small, scriptable Node.js CLI.

Deploydo 3 is a security-focused major release: it uses modern transfer clients,
validates configuration before connecting, supports CI-friendly credentials, and
keeps a SHA-256 manifest to upload only changed files.

## Requirements

- Node.js 20 or newer
- An SFTP, FTPS, or FTP server

## Install

```shell
npm install --global deploydo
```

## Quick start

Create a configuration template in the current project:

```shell
deploydo init
```

Edit `deploydo.config.json`, then validate it:

```shell
deploydo validate
```

Set the configured password variable and inspect the transfer without changing the server:

```shell
DEPLOYDO_PASSWORD='your-secret' deploydo deploy --dry-run
```

Run the deployment interactively, or use `--yes --non-interactive` in CI:

```shell
DEPLOYDO_PASSWORD='your-secret' deploydo deploy --profile default --yes --non-interactive
```

To enter a password once and reuse it on this computer, add `--save-password`
to an interactive deployment. Deploydo saves it only after a successful
connection:

```shell
deploydo deploy --profile production --save-password
```

`deploydo --sample` remains an alias for `deploydo init`.

## Configuration

V3 prefers `deploydo.config.json`. The `sourcePath` is relative to the
configuration file; remote paths always use POSIX separators.

```json
{
  "profiles": {
    "production": {
      "protocol": "sftp",
      "host": "example.com",
      "port": 22,
      "username": "deploy",
      "sourcePath": "dist",
      "remotePath": "/var/www/html",
      "exclude": ["**/*.map"],
      "build": { "command": "npm run build" },
      "auth": {
        "passwordEnv": "DEPLOYDO_PRODUCTION_PASSWORD"
      },
      "sync": { "useManifest": true },
      "connection": { "retries": 2 }
    }
  }
}
```

Profiles support these fields:

| Field | Meaning |
| --- | --- |
| `protocol` | `sftp`, `ftps`, or `ftp` |
| `host`, `port`, `username` | Server connection details; ports default to 22 for SFTP and 21 for FTP/explicit FTPS |
| `sourcePath`, `remotePath` | Local source directory and remote target directory |
| `exclude` | A glob or a list of globs to omit from the upload |
| `verbose` | Print individual file operations; `--verbose` overrides it for one run |
| `build.command` | Optional shell command run before a real deployment |
| `auth.passwordEnv` | Environment variable containing the password |
| `auth.privateKeyPath` | SFTP private key path, relative to the configuration file |
| `auth.privateKeyPassphraseEnv` | Environment variable for the private-key passphrase |
| `auth.hostFingerprint` | Optional SHA-256 host-key pin for SFTP |
| `sync.useManifest` | Enables the changed-file manifest; enabled by default |
| `sync.manifestPath` | Relative remote manifest name; defaults to `deploydo.manifest.json` |
| `connection.retries` | Retry count for transient connection errors; defaults to 2 |

For FTPS, add an optional `ftps` block:

```json
{
  "protocol": "ftps",
  "ftps": { "mode": "explicit", "rejectUnauthorized": true }
}
```

`mode` may be `explicit` or `implicit`; implicit FTPS defaults to port 990.
Plain FTP remains available for old servers, but Deploydo warns because it does
not encrypt credentials or transferred files.

## Credentials and CI

Never put passwords in `deploydo.config.json`.

- Use `auth.passwordEnv` for password authentication.
- Use `auth.privateKeyPath` and `auth.privateKeyPassphraseEnv` for SFTP keys.
- Use `--password-stdin` for a one-time pipeline secret. It requires `--yes`
  for a real deployment.
- `deploy --save-password` stores the interactively entered password in the
  operating-system credential store after a successful connection. The next
  interactive deployment uses it automatically when no password environment
  variable is set. Environment variables and `--password-stdin` take priority.
- Remove a stored password with `deploydo credentials delete --profile <name>`.
- Deploydo only prompts on an interactive TTY. `--non-interactive` fails if a
  secret is missing.

On Windows this is Windows Credential Manager, on macOS the Keychain, and on
Linux the Secret Service. No password is written to `deploydo.config.json`, the
project directory, or a Deploydo-specific password file.

Example CI command:

```shell
deploydo deploy --profile production --yes --non-interactive --json
```

In JSON mode, stdout contains one final result object. Warnings and errors are
written to stderr.

## Synchronization and deletion

Deploydo scans regular files, including dotfiles such as `.htaccess`, and
calculates SHA-256 hashes. A successful deploy writes a remote
`deploydo.manifest.json`; unchanged files are skipped on later deploys. The
default deliberately avoids a leading dot because some hardened FTP servers
prohibit dot-file writes.

`--dry-run` reads the remote manifest but never uploads, deletes, or updates it.
It also skips the configured build command by default.

`--delete` is deliberately conservative: it removes only paths from a previous
Deploydo manifest that are no longer in the local source. It never mirrors or
deletes arbitrary remote files.

## Commands

```text
deploydo deploy [--profile <name>|--env <name>] [--config <file>]
                 [--dry-run] [--delete] [--yes] [--no-build]
                 [--non-interactive] [--password-stdin] [--save-password] [--json]

deploydo validate [--profile <name>|--env <name>] [--config <file>] [--json]
deploydo credentials delete [--profile <name>|--env <name>] [--config <file>]
deploydo init [--output <file>] [--force]
deploydo migrate [--config <legacy-file>] [--output <file>] [--force]
```


## Migrating V2

`deploy.conf.json` is still read as a legacy configuration and emits a warning.
The legacy `--env` and `--deployConfigFile` flags remain available.

Create a V3 file without copying any passwords:

```shell
deploydo migrate --config deploy.conf.json
```

V2 source paths beginning with `/` retain their old working-directory-relative
meaning while the legacy file is used. The generated V3 configuration converts
such paths to the explicit relative form, for example `/dist` becomes `dist`.

Existing `deploy.pw.conf.json` files are ignored unless
`--allow-legacy-password-file` is explicitly passed. This switch is intended as
a short migration bridge only.

## Development

```shell
npm test
npm run lint
npm run check
npm run pack:check
```

Run the protocol integrations locally with Docker:

```shell
npm run integration:up
DEPLOYDO_INTEGRATION=1 npm run test:integration
docker compose -f docker-compose.integration.yml down -v
```

The integration stack provides isolated SFTP, FTP, and explicit-FTPS servers.
FTPS uses a self-signed certificate, so its test profile deliberately sets
`rejectUnauthorized` to `false`; production profiles should keep the default
of `true`.

Equivalent `:rtk` scripts are available in environments that use Rust Token
Killer. The test suite covers configuration validation and migration, secrets,
dotfiles, SHA-256 manifests, dry-runs, safe deletion, and failure exit paths.
