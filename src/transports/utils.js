export function isNotFoundError(error) {
  if (!error) return false;
  if (error.code === 'ENOENT' || error.code === 2 || error.code === '2' || error.code === 550 || error.code === '550') return true;
  return /(?:no such file|not found|does not exist|\b550\b)/i.test(error.message ?? '');
}

export function isAuthenticationError(error) {
  return /(?:authentication|login|password|permission denied|access denied|host key|fingerprint|\b530\b)/i.test(error?.message ?? '');
}
