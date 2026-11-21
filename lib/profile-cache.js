"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

function retiredCacheDir(profileDir) {
  return path.join(path.dirname(profileDir), ".intake-retired-cache");
}

function assertPrivateDirectory(target, privateOnly = true) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & (privateOnly ? 0o077 : 0o022)) !== 0) {
    throw new Error("TherapyNotes retired cache path is not private and owner-controlled.");
  }
}

// Called only after securePathTree has verified the profile ancestry and the
// helper has proven exact account ownership and absence of browser processes.
// Rename is constant work: never traverse/delete cache entries before launch
// or while the account lock is held. Both caches are disposable Chrome data.
function retireDiskCaches(profileDir) {
  const defaultDir = path.join(profileDir, "Default");
  try { assertPrivateDirectory(defaultDir, false); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const retired = retiredCacheDir(profileDir);
  for (const [name, prefix] of [["Cache", "http"], ["Code Cache", "code"]]) {
    const source = path.join(defaultDir, name);
    try { assertPrivateDirectory(source, false); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    try { fs.mkdirSync(retired, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    assertPrivateDirectory(retired);
    fs.chmodSync(source, 0o700);
    fs.renameSync(source, path.join(retired, `${prefix}-${randomBytes(16).toString("hex")}`));
  }
}

// These directories are outside every browser profile and were detached while
// the lock was owned. GC does not need or acquire the TN lock. Validate the
// complete user-owned ancestry again without traversing any active profile.
function purgeRetiredCaches(profileDir) {
  const retired = retiredCacheDir(profileDir);
  const home = require("node:os").homedir();
  if (!path.isAbsolute(profileDir) || path.resolve(profileDir) !== profileDir ||
      !retired.startsWith(`${home}${path.sep}`)) throw new Error("Invalid retired cache ancestry.");
  assertPrivateDirectory(home, false);
  let current = home;
  for (const component of path.relative(home, retired).split(path.sep)) {
    current = path.join(current, component);
    try { assertPrivateDirectory(current, current === retired); }
    catch (error) { if (error.code === "ENOENT") return { removed: 0 }; throw error; }
  }
  let removed = 0;
  for (const entry of fs.readdirSync(retired)) {
    if (!/^(http|code)-[a-f0-9]{32}$/.test(entry)) throw new Error("Invalid retired cache entry.");
    const target = path.join(retired, entry);
    try {
      assertPrivateDirectory(target);
      fs.rmSync(target, { recursive: true, force: true });
      removed++;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { removed };
}

module.exports = { retiredCacheDir, retireDiskCaches, purgeRetiredCaches };
