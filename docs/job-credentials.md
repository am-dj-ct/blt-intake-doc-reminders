# Credentials for scheduled jobs

One Login item per account in vault `BLT Automation`, titled `<Site> - <account label>`. Standard fields are `username`, `password`, and `one-time password` for TOTP. API keys use `password`; configured application identifiers use `username` where listed. Reference form: `op://BLT Automation/<title>/<field>`.

| Actual caller | Existing Doppler fallback | Item title | Field |
|---|---|---|---|
| `lib/send.js` | `BLT_GRAPH_CLIENT_ID` | `Microsoft Graph - BLT` | `username` |
| `lib/send.js` | `BLT_GRAPH_CLIENT_SECRET` | `Microsoft Graph - BLT` | `password` |
| `scripts/send-watch-alert.cjs` (existing watcher) | `RESEND_API_KEY` | `Resend - BLT` | `password` |
| `lib/classify.js` | `BLT_AZURE_OPENAI_API_KEY` | `Azure OpenAI - BLT` | `password` |
| `lib/classify.js` generic configured account | `AZURE_OPENAI_API_KEY` | `Azure OpenAI - default` | `password` |

The resolver tries the read-only 1Password service account first, then the existing Doppler variable. `OP_SERVICE_ACCOUNT_TOKEN` is bootstrap authentication supplied by the existing Doppler wrapper. Missing items, unavailable `op`, or missing bootstrap token retain the prior fallback. Only account names and `credential_source=1password|doppler` appear in existing run output. Credential values and subprocess errors are never logged or cached. Existing TherapyNotes broker locks and account selection remain unchanged where used.

Do not create or change vault items during wiring, run live portal sign-ins, or test by sending mail. Synthetic tests use a fake `op` executable and fake HTTP calls. Deployment uses the existing sibling release controller; do not edit or pull the live checkout or run launchctl by hand. Read the controller receipt and compare installed changed-file bytes with the reviewed merged Git objects. Ordinary scheduled runs provide later live proof.
