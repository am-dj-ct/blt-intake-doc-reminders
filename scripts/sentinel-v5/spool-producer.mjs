// Sentinel-v5 spool PRODUCER path — spec v5.9 §3.1, producer path only.
//
// ============================================================================
// CROSS-REPO COORDINATION FLAG (read before touching this file)
// ============================================================================
// Per SPEC-2026-08-06-sentinel-fleet-v5.md §3.1, the producer path is meant
// to be "the shared helper" every job in the fleet calls — one implementation,
// reused fleet-wide, living in blt-hub's src/sentinel-v5/spool.ts. blt-hub's
// package.json has no "exports"/"bin"/"files" field, and its compiled dist/
// is gitignored — there is no installable-package path a sibling repo can
// pull that helper from today (same documented gap as caller-track's port,
// scripts/sentinel-v5/spool-producer.mjs). Implemented here against the
// documented spool contract directly, ported byte-for-byte from
// caller-track's own working producer, which is itself already landing real
// check-ins in the shared spool.
//
// This file is a deliberately narrowed port of blt-hub's spoolProduceCheckin
// (spool.ts): PRODUCER PATH ONLY. blt-intake-doc-reminders never consumes the spool
// (the consumer, sweep, and recovery loops are blt-hub's), so this file
// omits spool.ts's SentinelV5Spool class, quota sweep, and recovery logic
// entirely. What IS ported (write path, locking, ring eviction, size
// validation) is ported faithfully — same directory layout, same filename
// format, same fsync ordering, same lock semantics.
// ============================================================================

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalSha256Hex, canonicalizeJcs } from "./canonical.mjs";
import { isGroupItem, isKnownItem } from "./item-registry.mjs";
import { validateCheckinShape } from "./checkin-schema.mjs";
import { isItemEnabled } from "./cron-slot.mjs";

export const SENTINEL_V5_ROOT_ENV = "SENTINEL_V5_SPOOL_ROOT";
export const SPOOL_DIRS = ["tmp", "incoming", "processing", "quarantine", "done"];

export const SPOOL_DEFAULT_LIMITS = {
  maxPayloadBytes: 64 * 1024,
  ringSize: 50,
  lockStaleMs: 10 * 60 * 1000,
};

export class SentinelV5SpoolError extends Error {}

// Review round-1 activation-blocker fix: telemetry must never delay or hang
// the host job. The old acquireLock busy-waited up to 30s on contention —
// even inside emitCheckin's try/catch, that synchronous block happens
// BEFORE the catch ever runs, so the host job actually stalled for up to
// 30s on a busy lock. Contention now throws this immediately (one
// non-blocking attempt, no retry loop) and the caller drops the check-in —
// losing one check-in beats blocking a real job; the sentinel's own
// absence detection covers the loss.
export class SentinelV5SpoolBusyError extends SentinelV5SpoolError {}

export function resolveSpoolRoot(env = process.env) {
  return env[SENTINEL_V5_ROOT_ENV]?.trim() || join(homedir(), ".blt-sentinel", "spool");
}

export function ensureSpoolDirs(root) {
  for (const dir of SPOOL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  }
  mkdirSync(join(root, "locks"), { recursive: true, mode: 0o700 });
}

export function spoolFilename(item, runId, hash) {
  // §3.1: `<item>__<run_id>__<full sha256 hex of canonical payload>.json`.
  return `${item}__${runId}__${hash}.json`;
}

// ---- owner ledger (contract parity with blt-hub's spool.ts) ----
// A single append-only file directly under root, OUTSIDE every SPOOL_DIRS
// directory, recording one filename per line for every check-in THIS root's
// own spoolProduceCheckin genuinely admitted. Ported from spool.ts's
// spoolOwnerLedgerRecordAdmission — O_NOFOLLOW refuses a symlinked ledger
// path, and the nlink===1 check on the open fd refuses a hardlink to a
// foreign file (indistinguishable from an ordinary file at open() time).
// Best-effort: a missing entry only ever makes future recovery MORE
// conservative, never less, so any failure here is swallowed.
function spoolOwnerLedgerPath(root) {
  return join(root, ".owner-ledger");
}

function spoolOwnerLedgerRecordAdmission(root, filename) {
  try {
    const fd = openSync(
      spoolOwnerLedgerPath(root),
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      if (fstatSync(fd).nlink !== 1) {
        throw new Error(`refusing to write ${spoolOwnerLedgerPath(root)}: nlink !== 1`);
      }
      writeFileSync(fd, `${filename}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best-effort only — see doc comment above.
  }
}

const SPOOL_FILENAME_PATTERN =
  /^([a-z0-9][a-z0-9-]{0,63})__\1-(\d{10,14})-(\d{1,7})__([0-9a-f]{64})\.json$/;

export function parseSpoolFilename(name) {
  const match = SPOOL_FILENAME_PATTERN.exec(name);
  if (!match) return undefined;
  const item = match[1];
  const epoch = match[2];
  const pid = match[3];
  return { item, runId: `${item}-${epoch}-${pid}`, hash: match[4], runEpochMs: Number(epoch) };
}

function isFsError(error, ...codes) {
  return Boolean(error && typeof error === "object" && "code" in error && codes.includes(error.code));
}

function fsyncDir(dir) {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function oldestFirst(a, b) {
  if (a.mtime !== b.mtime) return a.mtime - b.mtime;
  const ea = parseSpoolFilename(a.name)?.runEpochMs ?? Number.MAX_SAFE_INTEGER;
  const eb = parseSpoolFilename(b.name)?.runEpochMs ?? Number.MAX_SAFE_INTEGER;
  if (ea !== eb) return ea - eb;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function listSpoolEntries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => parseSpoolFilename(name) !== undefined)
    .map((name) => {
      try {
        const stats = statSync(join(dir, name));
        return { name, mtime: stats.mtimeMs, size: stats.size };
      } catch (error) {
        if (isFsError(error, "ENOENT")) return undefined;
        throw new SentinelV5SpoolError(`stat failed on ${join(dir, name)}: ${error.code ?? error}`);
      }
    })
    .filter((entry) => entry !== undefined)
    .sort(oldestFirst);
}

/**
 * Producer path (§3.1) — serialized per item by a per-item mkdir lock.
 * Never blocks indefinitely, never silently rejects: oversize is replaced
 * in-band; an unknown item or malformed payload throws to the caller (this
 * repo's callers are all in-process node wrappers, so a thrown error is a
 * loud failure, not a silent drop).
 */
export function spoolProduceCheckin(root, checkin, limits = SPOOL_DEFAULT_LIMITS) {
  // Round-4 review fix: both gates now run BEFORE ensureSpoolDirs — a
  // disabled (or unknown) item must be FULLY inert, including never
  // creating the spool directory tree in the first place. Neither check
  // needs the directories to exist.
  if (!isKnownItem(checkin.item)) {
    throw new SentinelV5SpoolError(`unknown item: ${checkin.item}`);
  }
  // Contract-parity fix: "enabled: false" means fully inert at the
  // producer, not merely filtered downstream.
  if (!isItemEnabled(checkin.item)) {
    return { admitted: false, filename: null, reason: "item_disabled" };
  }
  ensureSpoolDirs(root);
  const isGroup = isGroupItem(checkin.item);
  let payload = validateCheckinShape({ ...checkin, overwrote_prior: false }, isGroup);
  let replaced = null;
  let canonical = canonicalizeJcs(payload);
  if (Buffer.byteLength(canonical, "utf8") > limits.maxPayloadBytes) {
    // §3.1 step 1 — oversize is REPLACED by a minimal red check-in.
    const minimal = {
      schema: 2,
      item: payload.item,
      repo: payload.repo,
      status: "red",
      at: payload.at,
      slot: payload.slot,
      run_id: payload.run_id,
      reason_code: "oversize",
      overwrote_prior: false,
      ...(isGroup ? { children: [] } : {}),
      evidence_ref: payload.evidence_ref,
    };
    payload = validateCheckinShape(minimal, isGroup);
    canonical = canonicalizeJcs(payload);
    replaced = "oversize";
  }

  const lockDir = join(root, "locks", `item-${payload.item}.lock`);
  const lockToken = acquireLock(lockDir, limits.lockStaleMs);
  try {
    // §3.1 step 2 — ring eviction: if incoming holds >= ringSize for this
    // item, unlink oldest until <= ringSize - 1 (evict-below-then-add).
    let evicted = 0;
    for (;;) {
      const mine = listSpoolEntries(join(root, "incoming")).filter((entry) =>
        entry.name.startsWith(`${payload.item}__`),
      );
      if (mine.length < limits.ringSize) break;
      const target = mine[0].name;
      try {
        unlinkSync(join(root, "incoming", target));
        evicted += 1;
      } catch (error) {
        if (!isFsError(error, "ENOENT")) {
          throw new SentinelV5SpoolError(`ring eviction failed on ${target}: ${error.code ?? error}`);
        }
      }
      if (evicted > 0 && !payload.overwrote_prior) {
        // overwrote_prior flips BEFORE hashing (§3.1 step 2).
        payload = { ...payload, overwrote_prior: true };
        canonical = canonicalizeJcs(payload);
      }
    }

    // §3.1 step 3 — write tmp, fsync file, rename into incoming, fsync dir.
    const hash = canonicalSha256Hex(payload);
    const filename = spoolFilename(payload.item, payload.run_id, hash);
    const tmpPath = join(root, "tmp", filename);
    const fd = openSync(tmpPath, "w", 0o600);
    try {
      writeFileSync(fd, canonical, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, join(root, "incoming", filename));
    fsyncDir(join(root, "incoming"));
    spoolOwnerLedgerRecordAdmission(root, filename);
    return { admitted: true, filename, replaced, evicted };
  } finally {
    releaseLock(lockDir, lockToken);
  }
}

// ---- mkdir lock with ownership token + liveness-checked staleness break ---
// Ported from spool.ts's acquireLock/releaseLock (same semantics: owner file
// records "<pid>-<epoch>-<nonce>"; a stale break requires BOTH the age
// threshold AND the recorded holder pid being dead, unless past 6x the
// threshold (pid-reuse hard cap)).

/**
 * ONE non-blocking attempt, no retry loop, no busy-wait. Either the lock is
 * free (or breakably stale, broken in one try) and this returns immediately,
 * or it's genuinely held by a live owner and this throws
 * SentinelV5SpoolBusyError immediately — total wall time is a handful of
 * synchronous filesystem syscalls, never seconds.
 */
function acquireLock(lockDir, staleMs) {
  const token = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (isFsError(error, "ENOENT")) {
      // Parent (locks/) missing — create it and make ONE more attempt, still
      // non-blocking; a second miss here means genuine contention or error.
      try {
        mkdirSync(join(lockDir, ".."), { recursive: true, mode: 0o700 });
        mkdirSync(lockDir);
      } catch (retryError) {
        if (isFsError(retryError, "EEXIST")) {
          throw new SentinelV5SpoolBusyError(`lock busy: ${lockDir}`);
        }
        throw new SentinelV5SpoolError(`lock directory setup failed: ${lockDir}: ${retryError.code ?? retryError}`);
      }
    } else if (isFsError(error, "EEXIST")) {
      const observedOwner = readLockOwner(lockDir) ?? "<no-owner>";
      if (!lockIsBreakableFor(lockDir, staleMs, observedOwner)) {
        throw new SentinelV5SpoolBusyError(`lock busy: ${lockDir}`);
      }
      // Stale — ONE attempt to break it (same tombstone-swap semantics as
      // before), no retry loop after.
      const tombstone = `${lockDir}.stale-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
      try {
        renameSync(lockDir, tombstone);
        const renamedOwner = readLockOwner(tombstone) ?? "<no-owner>";
        if (renamedOwner !== observedOwner) {
          // Someone else already broke it and is mid-acquire — put it back
          // and treat this as contention, not a crash.
          renameSync(tombstone, lockDir);
          throw new SentinelV5SpoolBusyError(`lock busy: ${lockDir}`);
        }
        rmSync(tombstone, { recursive: true, force: true });
        mkdirSync(lockDir);
      } catch (breakError) {
        if (breakError instanceof SentinelV5SpoolBusyError) throw breakError;
        throw new SentinelV5SpoolBusyError(`lock busy (break attempt failed): ${lockDir}`);
      }
    } else {
      throw new SentinelV5SpoolError(`lock acquisition failed: ${lockDir}: ${error.code ?? error}`);
    }
  }
  try {
    writeFileSync(join(lockDir, "owner"), token, "utf8");
  } catch (error) {
    throw new SentinelV5SpoolError(`lock owner write failed: ${lockDir}: ${error.code ?? error}`);
  }
  if (readLockOwner(lockDir) !== token) {
    throw new SentinelV5SpoolBusyError(`lock owner mismatch (lost the race): ${lockDir}`);
  }
  return token;
}

function lockIsBreakableFor(lockDir, staleMs, observedOwner) {
  let age;
  try {
    age = Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return false;
  }
  if ((readLockOwner(lockDir) ?? "<no-owner>") !== observedOwner) return false;
  if (age <= staleMs) return false;
  if (age > staleMs * 6) return true;
  const pid = pidFromOwner(observedOwner);
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function pidFromOwner(owner) {
  const pid = Number(owner.split("-")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function readLockOwner(lockDir) {
  try {
    return readFileSync(join(lockDir, "owner"), "utf8");
  } catch {
    return undefined;
  }
}

function releaseLock(lockDir, token) {
  try {
    const owner = readFileSync(join(lockDir, "owner"), "utf8");
    if (owner !== token) return;
    unlinkSync(join(lockDir, "owner"));
    rmdirSync(lockDir);
  } catch {
    // Already broken; nothing to release.
  }
}
