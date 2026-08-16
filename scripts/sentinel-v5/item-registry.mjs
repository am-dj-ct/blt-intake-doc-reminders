// Local closed-vocab snapshot of blt-intake-doc-reminders' own sentinel-v5
// item ids.
//
// The real registry (schedule/tier/protected paths/escalation/oracle) lives
// in blt-hub's config/sentinel-v5-registry.json (spec v5.9 §3.2) — this repo
// does not own that file. It delivers
// config/sentinel-v5-registry-fragment.blt-intake-doc-reminders.json as a
// reviewed artifact for the coordinator to land in blt-hub's registry, same
// pattern caller-track and desktop-janitor already established.
//
// This local allowlist is the closed vocabulary this repo's own producer
// enforces at the door — it MUST stay in exact sync with the `id` field of
// the fragment file above.
export const INTAKE_DOC_REMINDERS_ITEMS = {
  // com.blt.intake-doc-reminders — hourly 07:35..20:35 PT, run.sh -> index.js
  "idr-hourly-reminders": { group: false },
};

export function isKnownItem(item) {
  return Object.prototype.hasOwnProperty.call(INTAKE_DOC_REMINDERS_ITEMS, item);
}

export function isGroupItem(item) {
  return Boolean(INTAKE_DOC_REMINDERS_ITEMS[item]?.group);
}
