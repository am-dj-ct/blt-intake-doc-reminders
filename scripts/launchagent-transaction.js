"use strict";

async function rollbackOne(snapshot, operations) {
  const errors = [];
  for (const action of [
    () => operations.bootout(),
    () => snapshot.exists ? operations.write(snapshot.content) : operations.remove(),
    () => snapshot.disabledState === "disabled" ? operations.disable() : snapshot.disabledState === "enabled" ? operations.enable() : undefined,
    () => snapshot.loaded ? operations.bootstrap() : operations.bootout(),
  ]) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  try {
    const actual = await operations.inspect();
    if (actual.exists !== snapshot.exists || actual.content !== snapshot.content || actual.loaded !== snapshot.loaded ||
        actual.disabledState !== snapshot.disabledState) {
      errors.push(new Error("restored state did not match the private backup"));
    }
  } catch (error) { errors.push(error); }
  return errors;
}

async function replaceOneLaunchAgent({ snapshot, operations }) {
  try {
    await operations.bootout();
    await operations.writeNew();
    if (snapshot.disabledState !== "absent") await operations.enable();
    await operations.bootstrap();
    const installed = await operations.inspect();
    const expectedState = snapshot.disabledState === "absent" ? "absent" : "enabled";
    if (!installed.exists || installed.disabledState !== expectedState || !installed.loaded || installed.content !== operations.newContent) {
      throw new Error("installed launch agent did not match the reviewed state");
    }
    return installed;
  } catch (installError) {
    const rollbackErrors = await rollbackOne(snapshot, operations);
    if (rollbackErrors.length) {
      throw new AggregateError([installError, ...rollbackErrors], "installation failed and rollback is incomplete", { cause: installError });
    }
    throw new Error("installation failed; prior state was verified restored", { cause: installError });
  }
}

module.exports = { replaceOneLaunchAgent, rollbackOne };
