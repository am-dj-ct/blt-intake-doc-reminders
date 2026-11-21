// Count-only, immutable weekly oversight events. No client identity in payloads.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
function recordDirectorEvent({ key, stage, now, root = process.env.BLT_WEEKLY_DIRECTOR_ROOT || path.join(os.homedir(), '.blt-hub/reports/weekly-director') }) {
  if (!['nag', 'confirm'].includes(stage)) throw new Error('Invalid intake rollup stage');
  const dir = path.join(root, 'intake');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, createHash('sha256').update(key).digest('hex') + '.json');
  const value = { version: 1, source: 'intake', occurredAt: now.toISOString(), stage };
  const tmp = path.join(dir, '.' + randomUUID() + '.tmp');
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Hard-link publishes only a complete inode and never replaces a prior event.
    try { fs.linkSync(tmp, target); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const prior = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (prior.version !== 1 || prior.source !== 'intake' || prior.stage !== stage || !Number.isFinite(Date.parse(prior.occurredAt))) throw new Error('Existing intake rollup event invalid');
    }
    for (const directoryPath of [dir, root, path.dirname(root)]) {
      const directory = fs.openSync(directoryPath, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
module.exports = { recordDirectorEvent };
