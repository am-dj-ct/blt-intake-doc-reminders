"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("orchestration helpers do not resolve runtime SDKs at import time", async () => {
  const originalLoad = Module._load;
  Module._load = function guardedLoad(request, parent, isMain) {
    if (["playwright", "openai"].includes(request)) {
      throw new Error(`${request} must only load when its runtime operation starts`);
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve("../lib/tn")];
    delete require.cache[require.resolve("../lib/classify")];
    delete require.cache[require.resolve("../index")];

    const tn = require("../lib/tn");
    const { classifyDocs } = require("../lib/classify");
    const index = require("../index");

    assert.equal(tn.ymd(new Date(2026, 7, 28)), "2026-08-28");
    assert.equal(typeof index.digestSuppressible, "function");
    assert.deepEqual(await classifyDocs([]), {
      hasSOD: false,
      hasGAINSS: false,
      sodEvidence: "",
      gainssEvidence: "",
    });
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve("../lib/tn")];
    delete require.cache[require.resolve("../lib/classify")];
    delete require.cache[require.resolve("../index")];
  }
});
