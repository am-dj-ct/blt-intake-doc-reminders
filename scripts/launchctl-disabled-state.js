"use strict";

function parseLaunchctlDisabledState(output, label) {
  const text = String(output);
  const exactLabel = String(label);
  if (!/^[A-Za-z0-9._-]+$/.test(exactLabel)) throw new Error("launchd disabled-state label was malformed");
  let index = 0;
  const skipSpace = () => { while (index < text.length && /\s/.test(text[index])) index += 1; };
  skipSpace();
  if (!text.startsWith("disabled services", index)) throw new Error("launchd disabled-state inventory was malformed");
  index += "disabled services".length;
  skipSpace();
  if (text[index++] !== "=") throw new Error("launchd disabled-state inventory was malformed");
  skipSpace();
  if (text[index++] !== "{") throw new Error("launchd disabled-state inventory was malformed");
  const states = new Map();
  while (true) {
    skipSpace();
    if (text[index] === "}") {
      index += 1;
      skipSpace();
      if (index !== text.length) throw new Error("launchd disabled-state inventory was malformed");
      break;
    }
    if (text[index++] !== '"') throw new Error("launchd disabled-state inventory was malformed");
    const end = text.indexOf('"', index);
    if (end < 0) throw new Error("launchd disabled-state inventory was malformed");
    const recordLabel = text.slice(index, end);
    index = end + 1;
    skipSpace();
    if (!text.startsWith("=>", index)) throw new Error("launchd disabled-state inventory was malformed");
    index += 2;
    skipSpace();
    const state = text.startsWith("enabled", index) ? "enabled" : text.startsWith("disabled", index) ? "disabled" : null;
    if (!state) throw new Error("launchd disabled-state inventory was malformed");
    index += state.length;
    if (index < text.length && !/\s|}/.test(text[index])) throw new Error("launchd disabled-state inventory was malformed");
    if (states.has(recordLabel)) throw new Error("launchd disabled-state inventory was malformed");
    states.set(recordLabel, state);
  }
  return states.get(exactLabel) || "absent";
}

module.exports = { parseLaunchctlDisabledState };
