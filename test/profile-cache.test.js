"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { securePathTree } = require("../lib/tn-account-session");
const { retireDiskCaches, retiredCacheDir, purgeRetiredCaches } = require("../lib/profile-cache");

for (const shape of ["slow-normal", "never-finishes"]) {
  test(`${shape} cache deletion cannot block prepare, reminder work, or lock release`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "idr-cache-lifecycle-"));
    const repo = path.join(__dirname, "..");
    // The real helper's validation/prepare/secure/purge code runs in a child.
    // Only the broker and deletion speed are synthetic; no vendor or network
    // entry point is invoked. All state and ownership files live in HOME.
    const code = `
      const fs = require('node:fs'), path = require('node:path');
      const { execFileSync } = require('node:child_process');
      const assert = require('node:assert/strict');
      const session = require('./lib/tn-account-session');
      const { runBoundedCleanup } = require('./lib/bounded-profile-cleanup');
      const profile = session.profileDirFor('blta');
      session.securePathTree(profile, { lockOwnershipVerified: true });
      for (const name of ['Cache','Code Cache']) {
        fs.mkdirSync(path.join(profile,'Default',name), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(profile,'Default',name,'synthetic'), 'cache', { mode: 0o600 });
      }
      fs.writeFileSync(path.join(profile,'Default','Cookies'), 'synthetic-auth', { mode: 0o600 });
      const lockPath = path.join(process.env.HOME,'lock');
      fs.writeFileSync(lockPath, 'synthetic-owner');
      const owner = { pid: process.pid, jobName: session.JOB_NAME, browserProfileDir: profile };
      const childCode = ${JSON.stringify(`
        const fs = require('node:fs'), path = require('node:path');
        const payload = JSON.parse(fs.readFileSync(0,'utf8'));
        const owner = payload.syntheticOwner;
        const remove = fs.rmSync;
        fs.rmSync = function(target, options) {
          if (String(target).includes('.intake-retired-cache') || /Default[\\/]Cache$/.test(String(target))) {
            fs.writeFileSync(path.join(process.env.HOME,'gc-pid'),String(process.pid));
            if (process.env.CACHE_SHAPE === 'never-finishes') while(true) {}
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);
          }
          return remove(target, options);
        };
        const broker = { lock: {
          lockDirFor: () => path.join(process.env.HOME,'lock'), readOwner: () => owner,
          verifyStillOwner: () => ({ok:fs.existsSync(path.join(process.env.HOME,'lock'))}),
          createLockDeps: () => ({listProcessesByProfileDir: () => []})
        }};
        const result = require('./scripts/cleanup-tn-profile').cleanupProfile(process.argv[1],payload,{broker});
        process.stdout.write(JSON.stringify(result || {ok:true}));
      `)};
      const helper = operation => runBoundedCleanup(operation, {profileDir:profile,syntheticOwner:owner}, {
        timeoutMs: operation === 'purge' ? 250 : 1000,
        execute: (_exe,_args,options) => execFileSync(process.execPath,['-e',childCode,operation],options)
      });
      const events=[];
      const lockSession = {ok:true,verifyStillOwner:()=>({ok:true}),release:async()=>{
        events.push('release'); fs.unlinkSync(lockPath); return {ok:true};
      }};
      const broker = {
        acquireAccountSession: async (_account,options) => {
          await options.onBeforeBrowserLaunch({verifyStillOwner:lockSession.verifyStillOwner});
          events.push('prepared'); return lockSession;
        },
        prepareProfileForLaunch:()=>helper('prepare'), secureProfileForRelease:()=>helper('secure'),
        lock:{killProfileDirAndConfirm:async()=>({confirmed:true,stillAlive:[]})},
        purgeRetiredCaches:()=>{
          assert.equal(fs.existsSync(lockPath),false); events.push('purge'); helper('purge');
        }
      };
      (async()=>{
        await session.acquireSession({account:'blta',broker,browserProfileDir:profile});
        assert.equal(fs.existsSync(path.join(profile,'Default','Cache')),false);
        assert.equal(fs.existsSync(path.join(profile,'Default','Code Cache')),false);
        assert.equal(fs.readFileSync(path.join(profile,'Default','Cookies'),'utf8'),'synthetic-auth');
        events.push('launch','decide');
        const result=await session.cleanupAndRelease({profileDir:profile,lockSession,broker});
        assert.equal(result.safeToClose,true); assert.equal(result.released,true);
        assert.deepEqual(events,['prepared','launch','decide','release','purge']);
        assert.equal(fs.existsSync(lockPath),false);
        const pid=Number(fs.readFileSync(path.join(process.env.HOME,'gc-pid'),'utf8'));
        assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
        console.log('Done. lockReleased=true');
      })().catch(e=>{console.error(e);process.exitCode=1});
    `;
    try {
      const result = spawnSync(process.execPath, ["-e", code], {
        cwd: repo, env: { ...process.env, HOME: home, CACHE_SHAPE: shape },
        encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.match(result.stdout, /Done\. lockReleased=true/);
      assert.match(result.stderr, /tn_cache_gc_deferred lockReleased=true/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}

test("retirement preserves authentication and refuses a symlinked garbage destination", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "idr-cache-security-"));
  const profile = path.join(home, "account", "browser-profile");
  try {
    securePathTree(profile, { lockOwnershipVerified: true });
    fs.mkdirSync(path.join(profile, "Default", "Cache"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(home, retiredCacheDir(profile));
    assert.throws(() => retireDiskCaches(profile), /private and owner-controlled/);
    assert.equal(fs.existsSync(path.join(profile, "Default", "Cache")), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("purge rejects paths outside HOME before deleting anything", () => {
  assert.throws(() => purgeRetiredCaches("/outside/account/browser-profile"), /ancestry/);
});

test("successful collection removes only detached caches and leaves the active profile intact", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "idr-cache-purge-"));
  const code = `
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    const session = require('./lib/tn-account-session');
    const cache = require('./lib/profile-cache');
    const profile = session.profileDirFor('blta');
    session.securePathTree(profile,{lockOwnershipVerified:true});
    fs.mkdirSync(path.join(profile,'Default','Cache'),{recursive:true,mode:0o755});
    fs.writeFileSync(path.join(profile,'Default','Cookies'),'synthetic-auth');
    cache.retireDiskCaches(profile);
    assert.equal(fs.readdirSync(cache.retiredCacheDir(profile)).length,1);
    assert.deepEqual(cache.purgeRetiredCaches(profile),{removed:1});
    assert.deepEqual(fs.readdirSync(cache.retiredCacheDir(profile)),[]);
    assert.equal(fs.readFileSync(path.join(profile,'Default','Cookies'),'utf8'),'synthetic-auth');
    fs.symlinkSync(profile,path.join(cache.retiredCacheDir(profile),'http-'+'a'.repeat(32)));
    assert.throws(()=>cache.purgeRetiredCaches(profile),/private and owner-controlled/);
    assert.equal(fs.existsSync(path.join(profile,'Default','Cookies')),true);
  `;
  try {
    const result = spawnSync(process.execPath, ["-e", code], {
      cwd: path.join(__dirname, ".."), env: { ...process.env, HOME: home },
      encoding: "utf8", timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
