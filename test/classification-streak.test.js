"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classificationSignal } = require("../index");

test("third consecutive candidate-bearing zero-intake run turns red", () => {
  const result = classificationSignal(
    { candidateCount: 16, virtualIntakeCount: 0 },
    { zeroIntakeCandidateStreak: 2 },
    3,
  );
  assert.deepEqual(result, {
    zeroIntakeCandidateStreak: 3,
    health: "red",
    alertCode: "video_candidates_zero_intakes_streak",
  });
});

test("a real intake or a candidate-free run resets the streak", () => {
  const previous = { zeroIntakeCandidateStreak: 9 };
  assert.equal(classificationSignal({ candidateCount: 16, virtualIntakeCount: 1 }, previous).zeroIntakeCandidateStreak, 0);
  assert.equal(classificationSignal({ candidateCount: 0, virtualIntakeCount: 0 }, previous).zeroIntakeCandidateStreak, 0);
});

test("the first two suspicious runs are recorded but not red", () => {
  const first = classificationSignal({ candidateCount: 3, virtualIntakeCount: 0 }, null, 3);
  const second = classificationSignal({ candidateCount: 3, virtualIntakeCount: 0 }, first, 3);
  assert.equal(first.zeroIntakeCandidateStreak, 1);
  assert.equal(second.zeroIntakeCandidateStreak, 2);
  assert.equal(second.health, "ok");
  assert.equal(second.alertCode, null);
});
