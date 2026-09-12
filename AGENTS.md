# Repository agent instructions

## Sentinel worker policy

Policy version: `sentinel-machine-ownership/v1`.

This policy governs only workers admitted by BLT Sentinel with a role packet. The packet names the controller owner, allowed operations, owned files, result transport, and result format. Assigned operational work, retries, releases, safe refusals, and unresolved dependencies remain machine-owned. A worker must not ask Jesse or staff to approve, decide, relay, run, monitor, or continue the work.

An operation outside the packet or blocked by safety policy stays refused. Return the observed condition, exact machine capability, next action, and wake evidence through the packet transport. Do not invent success or wider authority. Existing product role, released-tool, confirmation, destructive-action, PHI/BAA, single-writer, backup, idempotency, and audit controls remain binding.

Only Sentinel's independent recovery supervisor may authorize operator contact. It requires sustained unexpected host loss, a healthy independent observer, failed or unavailable supported remote recovery, no planned downtime, and a physical Mac inspection needed to restore observability or recovery. Paired email and Pushover must use identical text and state that the cause is unknown. Workers and source jobs have no page authority.
