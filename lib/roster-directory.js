'use strict';

// Validates a proposed CLINICIANS roster edit against the accepted
// TherapyNotes therapist directory snapshot, the same load-time guard
// pattern blt-eod-hours/lib/roster-directory.js uses for config/roster.json.
// The snapshot lives outside any repo (it is a shared machine artifact
// produced by the TherapyNotes directory adapter), so this is a small
// independent copy rather than a shared package -- consistent with how
// blt-eod-hours already keeps its own copy of the same idea.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_DIRECTORY_PATH = path.join(
  os.homedir(), '.blt-automation', 'therapynotes', 'directory', 'latest-accepted.json'
);

const INACTIVE_DIRECTORY_STATUSES = new Set([
  'inactive', 'terminated', 'removed', 'former', 'departed', 'disabled', 'archived', 'deactivated',
]);

const ROOM_SUFFIX_RE = /\s*\((?:room|rm)\b[^)]*\)/gi;

// "Last, First" -> "First Last" so a directory row and a config.js row that
// spell a name in either order still match. Mirrors
// blt-eod-hours/lib/therapist-key.js's normalizeDisplayName.
function normalizeDisplayName(displayName) {
  const raw = String(displayName == null ? '' : displayName).replace(ROOM_SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
  const comma = raw.indexOf(',');
  if (comma === -1 || raw.indexOf(',', comma + 1) !== -1) return raw;
  const last = raw.slice(0, comma).trim();
  const first = raw.slice(comma + 1).trim();
  if (!last || !first) return raw;
  return `${first} ${last}`;
}

function nameKey(displayName) {
  return normalizeDisplayName(displayName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function directoryRowIsActive(row) {
  if (!row) return false;
  if (row.removedAt) return false;
  if (INACTIVE_DIRECTORY_STATUSES.has(String(row.status == null ? '' : row.status).trim().toLowerCase())) return false;
  if (row.scheduleEligible === false) return false;
  return true;
}

function activeDirectoryKeys(rows) {
  return new Set((Array.isArray(rows) ? rows : []).filter(directoryRowIsActive).map((row) => nameKey(row.displayName)));
}

async function loadAcceptedDirectory(directoryPath = process.env.EOD_THERAPIST_DIRECTORY_PATH || DEFAULT_DIRECTORY_PATH) {
  const raw = JSON.parse(await fs.promises.readFile(directoryPath, 'utf8'));
  if (!raw || raw.pass !== true || raw.status !== 'succeeded' || !Array.isArray(raw.therapists)) {
    throw new Error('therapist directory is not an accepted successful snapshot');
  }
  const finishedAt = Date.parse(String(raw.finishedAt == null ? '' : raw.finishedAt));
  if (!Number.isFinite(finishedAt) || finishedAt > Date.now() + 60 * 60 * 1000 || Date.now() - finishedAt > 26 * 60 * 60 * 1000) {
    throw new Error('therapist directory snapshot is stale');
  }
  return raw.therapists.map((row) => ({
    displayName: row.displayName,
    status: row.status,
    removedAt: row.removedAt || row.RemovedAt || null,
    scheduleEligible: row.scheduleEligible,
  }));
}

// Refuses to activate a name absent from the active, schedule-eligible
// directory set. Deactivating (or removing) a clinician is always allowed --
// this only guards the direction that could invent an identity.
function assertNameInDirectory(displayName, directoryRows) {
  const keys = activeDirectoryKeys(directoryRows);
  const key = nameKey(displayName);
  if (!keys.has(key)) {
    throw new Error(
      `roster_directory_drift: "${displayName}" is not in the active, schedule-eligible TherapyNotes directory (directoryCount=${keys.size})`
    );
  }
  return true;
}

module.exports = {
  DEFAULT_DIRECTORY_PATH,
  normalizeDisplayName,
  nameKey,
  directoryRowIsActive,
  activeDirectoryKeys,
  loadAcceptedDirectory,
  assertNameInDirectory,
};
