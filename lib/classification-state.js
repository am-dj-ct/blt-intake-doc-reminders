'use strict';
const fs = require('node:fs');

// Failed runs did not prove the classifier healthy. Preserve only the day
// evidence, never stale scrape/send counts or the previous run's verdict.
function readClassificationState(statusPath) {
  let previous;
  try { previous = JSON.parse(fs.readFileSync(statusPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
  if (previous?.zeroIntakeStreakUnit !== 'service_days' || !Array.isArray(previous.zeroIntakeCandidateDays)) return {};
  return {
    zeroIntakeCandidateDays: previous.zeroIntakeCandidateDays,
    zeroIntakeCandidateStreak: previous.zeroIntakeCandidateDays.length,
    zeroIntakeStreakUnit: 'service_days',
    zeroIntakeAlertDays: previous.zeroIntakeAlertDays,
  };
}
module.exports = { readClassificationState };
