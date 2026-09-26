"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeClassification } = require("../lib/classify");

test("only exact boolean true marks intake documents present", () => {
  const falseLikeValues = ["true", "false", false, null, undefined, 1, 0];
  for (const value of falseLikeValues) {
    assert.deepEqual(normalizeClassification({
      hasSOD: value,
      hasGAINSS: value,
      sodEvidence: "Synthetic SOD row",
      gainssEvidence: "Synthetic GAINSS row",
    }), {
      hasSOD: false,
      hasGAINSS: false,
      sodEvidence: "Synthetic SOD row",
      gainssEvidence: "Synthetic GAINSS row",
    });
  }

  assert.deepEqual(normalizeClassification({
    hasSOD: true,
    hasGAINSS: true,
    sodEvidence: "Synthetic SOD row",
    gainssEvidence: "Synthetic GAINSS row",
  }), {
    hasSOD: true,
    hasGAINSS: true,
    sodEvidence: "Synthetic SOD row",
    gainssEvidence: "Synthetic GAINSS row",
  });
});
