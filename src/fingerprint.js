export function normalizeSshSha256Fingerprint(value) {
  const input = value.trim();
  const withoutPrefix = input.replace(/^sha256:/i, '');
  const hex = withoutPrefix.replaceAll(':', '');
  if (/^[a-f0-9]{64}$/i.test(hex)) return hex.toLowerCase();

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(withoutPrefix)) {
    throw new Error('must be a SHA-256 hex digest or an OpenSSH SHA256: base64 fingerprint');
  }
  const decoded = Buffer.from(withoutPrefix, 'base64');
  if (decoded.length !== 32) {
    throw new Error('must describe exactly 32 SHA-256 bytes');
  }
  return decoded.toString('hex');
}
