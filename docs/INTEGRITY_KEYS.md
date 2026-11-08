# Signing keys for match manifests

Finished matches get a signed manifest (`docs/INTEGRITY_SPEC.md`). This guide covers the signing key: where it lives, how to create it, how to rotate it, and what to do if it leaks.

## Where things live

| What | Where | Secret? |
|---|---|---|
| Private signing key (a 32-byte Ed25519 seed, base64url) | the `INTEGRITY_SIGNING_KEY` environment variable (Vercel project settings) | **yes**: never in git, never in the database, never in logs or chat |
| Public keys and their status (`active`, `retired`, `revoked`) | `src/integrity/published-keys.json` in the repository | no: it is published so anyone can verify |
| The signed manifest of a match | table `MatchManifest` | no |

Signing is **off** until both exist. Without `INTEGRITY_SIGNING_KEY` nothing is signed and matches stay `Unverified`; nothing breaks.

The code reads the key through a small `Signer` interface (`src/integrity/signing.ts`). To move the key into a key service (AWS KMS, GCP KMS, an HSM) later, implement `Signer` over it: the callers do not change, and the private key stops being a string in an environment variable.

## Create the first key, or rotate to a new one

```
node scripts/generate-integrity-key.mjs --secret-out ./integrity-key.secret
```

The script writes the private seed **only** to the file (mode 0600) and never prints it, adds the new public key to `src/integrity/published-keys.json` as `active`, and marks the previously active key `retired`. Then, in this order:

1. Store the secret: Vercel project, Settings, Environment Variables, `INTEGRITY_SIGNING_KEY` (Production), pasted from the file. Or `vercel env add INTEGRITY_SIGNING_KEY production < integrity-key.secret`.
2. Delete the secret file (`rm integrity-key.secret`).
3. Commit `src/integrity/published-keys.json` and deploy. Deploy the key set and the environment variable together: the code refuses to sign with a key that is not the published `active` key, so a mismatch means matches stay unsealed (and an error is logged) until it is fixed. They are sealed afterwards by the repair pass, within `INTEGRITY_SEAL_LOOKBACK_HOURS` (default 72).

Old signatures stay valid after a rotation because retired keys remain in the key set. **Never delete a key from `published-keys.json`.**

## If the key leaks

1. Generate and deploy a new key as above, so new matches are signed with a clean key.
2. Edit `src/integrity/published-keys.json`: set the leaked key's `status` to `revoked`, and deploy. Verifiers then reject everything that key signed, which is the point: nothing signed by it can be trusted.
3. Decide which of those matches to re-seal. Matches before the leak can be re-signed by deleting their `MatchManifest` row and calling `sealIfFinal` (the repair pass does this for recent ones). Only do that for matches whose logs you have independently checked.

## Sealing rules (what the code does)

- A match is signed when it reaches `COMPLETED`, `FAILED` or `CANCELLED`, no runner holds a live lease, and its stored hash chain re-verifies. A log that does not match its own hashes is never signed, and an error is logged.
- Matches that began before hash chaining existed are never signed (they have events without hashes) and are reported as unverified.
- While a manifest exists the log is **sealed**: appending events is refused. Retrying or resuming a match deletes the manifest; the next final state signs a new one.
- Where it is triggered: the runner at the end of every slice, the admin cancel action, and a repair pass in the per-minute sweeper.

## Settings

| Variable | Meaning |
|---|---|
| `INTEGRITY_SIGNING_KEY` | the private seed; unset means signing is off |
| `INTEGRITY_SEAL_LOOKBACK_HOURS` | how far back the repair pass looks for finished, unsealed matches (default 72) |
