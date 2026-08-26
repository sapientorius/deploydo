export class DeploydoError extends Error {
  constructor(message, { cause, code = 'DEPLOYDO_ERROR', exitCode = 1 } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class ConfigError extends DeploydoError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'CONFIG_ERROR', exitCode: 2 });
  }
}

export class UsageError extends DeploydoError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'USAGE_ERROR', exitCode: 2 });
  }
}

export class AuthenticationError extends DeploydoError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'AUTHENTICATION_ERROR', exitCode: 1 });
  }
}

export function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
