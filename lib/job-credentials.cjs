'use strict';
const { execFileSync } = require('node:child_process');

/** Resolve in memory only. Never expose subprocess errors or credential values. */
function resolveCredential(reference, fallbackName, env = process.env) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(fallbackName)) throw new Error('FALLBACK_NAME_INVALID');
  if (reference && !/^op:\/\/[^/\x00-\x1f?\x7f]+\/[^/\x00-\x1f?\x7f]+\/(?:[^/\x00-\x1f?\x7f]+\/)?[^/\x00-\x1f?\x7f]+$/.test(reference)) throw new Error('OP_REFERENCE_INVALID');
  if (reference && String(env.OP_SERVICE_ACCOUNT_TOKEN || '').trim()) {
    const childEnv = {};
    for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'TMPDIR']) {
      if (env[name] !== undefined) childEnv[name] = env[name];
    }
    Object.assign(childEnv, { OP_SERVICE_ACCOUNT_TOKEN: env.OP_SERVICE_ACCOUNT_TOKEN,
      OP_BIOMETRIC_UNLOCK_ENABLED: 'false', OP_CACHE: 'false' });
    try {
      const value = execFileSync('op', ['read', '--no-newline', reference], {
        env: childEnv, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 20000,
        maxBuffer: 1024 * 1024,
      });
      if (value.trim() && !value.includes('\0')) return { value, source: '1password' };
    } catch { /* Fall back without retaining or logging child output. */ }
  }
  const value = String(env[fallbackName] || '');
  if (value.trim()) return { value, source: 'doppler' };
  throw new Error('CREDENTIALS_MISSING');
}
module.exports = { resolveCredential };

// Keep only account/source names for duplicate suppression, never credential values.
const reportedSources = new Set();
function credential(name, title, field = 'password') {
  let resolved;
  try { resolved = resolveCredential(`op://BLT Automation/${title}/${field}`, name); }
  catch { return ''; }
  const stamp = `${title}:${resolved.source}`;
  if (!reportedSources.has(stamp)) {
    reportedSources.add(stamp);
    process.stderr.write(`account=${title.replaceAll(' ', '_')} credential_source=${resolved.source}\n`);
  }
  return resolved.value;
}
module.exports = { resolveCredential, credential };
