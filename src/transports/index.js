import { ConfigError } from '../errors.js';
import { FtpTransport } from './ftp.js';
import { SftpTransport } from './sftp.js';
export { isAuthenticationError, isNotFoundError } from './utils.js';

export function createTransport(profile, logger) {
  if (profile.protocol === 'sftp') return new SftpTransport(profile, logger);
  if (profile.protocol === 'ftp' || profile.protocol === 'ftps') return new FtpTransport(profile, logger);
  throw new ConfigError(`Unsupported protocol: ${profile.protocol}`);
}
