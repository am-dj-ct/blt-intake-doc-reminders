#!/usr/bin/env node
// Scripted repair for the blt-intake-doc-reminders half of the
// roster_directory_drift trust probe (blt-hub#2305). Adds a
// directory-backed clinician to config.js's CLINICIAN_EMAILS map, or drops a
// departed one, without a hand edit. Mirrors blt-eod-hours/scripts/roster-set.mjs:
// a temp-file-then-rename write and a refusal to invent an identity the
// TherapyNotes directory does not carry.
//
// CLINICIAN_EMAILS is a plain name -> email lookup with no active/inactive
// concept (see config.js's own comment: "if a clinician is not found here,
// the confirmation is skipped and logged rather than guessed"), so unlike
// therapy-hours' CLINICIANS array, a departed clinician is removed outright
// rather than flagged inactive -- there is no history to preserve in a
// lookup table.
//
// Usage:
//   roster-set.mjs --name "Full Name" --action add --email addr@... \
//     [--config path] [--directory path] [--force --reason "text"]
//   roster-set.mjs --name "Full Name" --action remove [--config path]

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertNameInDirectory, loadAcceptedDirectory } from '../lib/roster-directory.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const ENTRY_RE = /^(\s*)'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)',(\s*)$/;

function nameMatches(entryName, target) {
  return entryName.trim().toLowerCase() === target.trim().toLowerCase();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name || !['add', 'remove'].includes(args.action)) {
    console.error(
      'Usage: roster-set.mjs --name "Full Name" --action add|remove [--email addr] ' +
        '[--config path] [--directory path] [--force --reason "text"]'
    );
    process.exit(2);
  }

  const configPath = args.config || path.join(process.cwd(), 'config.js');
  const source = await readFile(configPath, 'utf8');
  const lines = source.split('\n');

  const startIndex = lines.findIndex((line) => line.trim().startsWith('const CLINICIAN_EMAILS = {'));
  if (startIndex < 0) throw new Error('roster-set: could not find "const CLINICIAN_EMAILS = {" in config.js');
  let endIndex = -1;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '};') { endIndex = i; break; }
  }
  if (endIndex < 0) throw new Error('roster-set: could not find the closing "};" for CLINICIAN_EMAILS');

  let matchIndex = -1;
  let matchedIndent = '  ';
  for (let i = startIndex + 1; i < endIndex; i += 1) {
    const m = ENTRY_RE.exec(lines[i]);
    if (!m) continue;
    if (nameMatches(m[2].replace(/\\'/g, "'"), args.name)) { matchIndex = i; matchedIndent = m[1]; break; }
  }

  if (args.action === 'remove') {
    if (matchIndex < 0) throw new Error(`roster-set: no existing CLINICIAN_EMAILS entry for ${JSON.stringify(args.name)}`);
    lines.splice(matchIndex, 1);
    await commit(configPath, lines);
    console.log(JSON.stringify({ removed: args.name }));
    return;
  }

  // action: add
  if (!args.email) throw new Error('roster-set: --email is required for --action add');
  if (args.force === 'true' || args.force === true) {
    if (!args.reason) throw new Error('roster-set: --force requires --reason "text"');
    console.error(JSON.stringify({ event: 'roster_directory_force', name: args.name, reason: args.reason }));
  } else {
    const directoryRows = await loadAcceptedDirectory(args.directory);
    assertNameInDirectory(args.name, directoryRows);
  }

  const line = `${matchIndex >= 0 ? matchedIndent : '  '}${quote(args.name)}: ${quote(args.email)},`;
  if (matchIndex >= 0) {
    lines[matchIndex] = line;
  } else {
    lines.splice(endIndex, 0, line);
  }
  await commit(configPath, lines);
  console.log(JSON.stringify({ [matchIndex >= 0 ? 'updated' : 'created']: args.name }));
}

async function commit(configPath, lines) {
  const tmp = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, lines.join('\n'), 'utf8');
  await rename(tmp, configPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
