// Sentinel-v5 RFC 8785 (JCS)-style canonicalization — ported from blt-hub
// master's src/sentinel-v5/canonical.ts (spec v5.9 §3.1/§3.4), via the same
// port caller-track already carries at scripts/sentinel-v5/canonical.mjs.
//
// Why a port instead of an import: blt-hub does not publish src/sentinel-v5/
// as an installable package today (no "exports"/"bin"/"files" field, and its
// compiled dist/ is gitignored). There is no cross-repo-consumable path yet.
// This file is a byte-for-byte port of the algorithm so that, once blt-hub
// does ship a shared package, this repo's spool filenames/hashes are already
// computed identically and a later migration is a pure import swap, not a
// re-derivation.
//
// Do not "simplify" this file independently of canonical.ts — the two must
// stay byte-identical in behavior or the content-hash-based spool filename
// invariant (same name = same bytes) breaks across repos.

import { createHash } from "node:crypto";

export class SentinelV5CanonicalizationError extends Error {}

export function canonicalizeJcs(value) {
  return serialize(value, new Set());
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalizeJcs(value), "utf8");
}

export function canonicalSha256Hex(value) {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

function serialize(value, seen) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new SentinelV5CanonicalizationError(`non-finite number: ${String(value)}`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new SentinelV5CanonicalizationError(`unsupported type: ${typeof value}`);
  }
  const obj = value;
  if (seen.has(obj)) {
    throw new SentinelV5CanonicalizationError("circular reference");
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((entry) => serialize(entry, seen)).join(",")}]`;
    }
    if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
      throw new SentinelV5CanonicalizationError("non-plain object");
    }
    const keys = Object.keys(obj).sort(compareUtf16);
    const parts = [];
    for (const key of keys) {
      const entry = obj[key];
      if (entry === undefined) {
        throw new SentinelV5CanonicalizationError(`undefined value at key: ${key}`);
      }
      parts.push(`${JSON.stringify(key)}:${serialize(entry, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

function compareUtf16(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
