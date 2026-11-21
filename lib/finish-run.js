"use strict";

function finishSuccessfulRun() {
  // Only called after reminder work and canonical account release completed.
  // Flush stdout before abandoning any stuck Playwright transport handles.
  process.stdout.write("", () => process.exit(0));
}

module.exports = { finishSuccessfulRun };
