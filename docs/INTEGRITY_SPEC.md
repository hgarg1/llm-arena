# Match integrity specification

**Spec version:** `arena-integrity/1`
**Status:** draft for implementation (milestone M1). Test vectors: [`integrity/test-vectors.json`](integrity/test-vectors.json).
**Reference implementation (for vectors only):** `tests/helpers/integrity-reference.ts`.

This document defines how a finished match is made tamper-evident. After a match ends, anyone who holds its events and its signed manifest can check, without access to our database, that the events are exactly the ones we recorded and that we vouched for them.

The key words MUST, MUST NOT and SHOULD are used as in RFC 2119.

## 1. What this proves, and what it does not

**Proves**
- The events in a match were not changed, removed, added or reordered after the manifest was signed.
- The manifest (game, seed, status, timestamps and any other signed field) was not changed after signing.
- The manifest was signed by a key we published, and that key was not revoked.

**Does not prove**
- That the models answered the way the log says. The log records what the runner stored, together with which prompt, model and sampling settings the runner says it used (section 4.5). Raw provider responses, token counts, latency and cost are recorded with each move (section 5.2) and committed to by the same digest.
- That re-running the match would give the same moves. Model output is not deterministic. Verification checks the record, not a re-execution.
- Anything about the order in which events were written in time. Row timestamps (`created_at`) are not part of the record (section 4.2).
- Protection against someone who holds the private signing key. Key custody is a separate control (story m1-04).

This is tamper **evidence**, not tamper prevention. An administrator with database access can still edit rows; the edit makes verification fail.

## 2. Conventions

- Text is UTF-8. Hashes are SHA-256. A hash in a document or database is 64 lowercase hexadecimal characters; when it is an input to another hash it is used as its 32 raw bytes.
- `||` means byte concatenation.
- Timestamps are strings in the form `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, exactly three fractional digits), or `null` when unknown.
- Ids are lowercase UUID strings exactly as stored.
- A domain-separation prefix starts every hash input so that a value valid in one role can never be replayed in another:

| Name | Bytes |
|---|---|
| `DOMAIN_GENESIS` | `"arena-integrity/1/genesis\n"` |
| `DOMAIN_EVENT` | `"arena-integrity/1/event"` followed by one `0x00` byte |
| `DOMAIN_MANIFEST` | `"arena-integrity/1/manifest"` followed by one `0x00` byte |

## 3. Canonical JSON

Everything that is hashed or signed is first serialized as **canonical JSON**: [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785) with the following profile.

1. No whitespace between tokens.
2. Object members are ordered by key, comparing keys as sequences of **UTF-16 code units** (not Unicode code points). Duplicate keys are not allowed.
3. Array order is preserved.
4. Strings use the minimal escapes: `\"`, `\\`, `\b`, `\t`, `\n`, `\f`, `\r`, any other code unit below `0x20` as `\u00xx` with lowercase hex, and every other character literally. `0x7f` and everything above is written literally. A string MUST NOT contain a lone surrogate.
5. Numbers use the ECMAScript `Number` to string algorithm (what `JSON.stringify` produces). Negative zero is written `0`. Additionally:
   - `NaN` and infinities are not allowed.
   - An integral number MUST be a safe integer, between −(2^53 − 1) and 2^53 − 1. Larger integral values (including `1e21`) are rejected, because consumers in other languages would silently round them.
6. `null`, `true`, `false` are written as such. `undefined`, dates, functions, big integers and non-plain objects are not JSON and are rejected. Convert dates to timestamp strings (section 2) before they enter an event or manifest.

A producer MUST canonicalize the value **as it will be read back from storage** (parse the stored JSON), not the in-memory object it started from, so that storage round trips cannot change a hash.

## 4. Events and the hash chain

### 4.1 Genesis

For a match with id `match_id`:

```
genesis = SHA-256( DOMAIN_GENESIS || UTF8(match_id) )
```

Binding the match id means an event log cannot be moved to another match.

### 4.2 The hashed record

Each stored event (the `MatchEvent` row) is reduced to this object. Its members are exactly these, in canonical order:

```json
{
  "actor_role": "player1",
  "match_id": "<match id>",
  "payload": { },
  "seq": 1,
  "turn_index": 1,
  "type": "ACTION",
  "v": 1
}
```

- `v` is the major spec version (`1`).
- `seq` is a non-negative integer. The events of a match MUST have `seq` values `0, 1, 2, …` with no gaps.
- `actor_role` is a string or `null`.
- **Not part of the record:** the database row id and `created_at`. They are operational metadata, so rewriting them does not affect verification. Anything that matters for audit (for example start and finish times) is recorded in the manifest instead.

### 4.3 Chaining

```
hash(0) = SHA-256( DOMAIN_EVENT || bytes(genesis)    || UTF8(canonical(record(0))) )
hash(i) = SHA-256( DOMAIN_EVENT || bytes(hash(i-1))  || UTF8(canonical(record(i))) )
```

The **head** of a log is the hash of its last event. The head of an empty log is `genesis`. The **event count** is the number of events.

Storing `hash` and `prev_hash` beside each event is allowed and recommended for convenience. They are never trusted: a verifier recomputes them.

### 4.4 Appending (implemented in `src/integrity/append.ts` and `MatchRepository`)

- The chain is extended inside the repository's append methods (`recordMove`, `addEvents`), in the same transaction that writes the rows, from the stored event with the highest `seq`. A move row is written first, so a runner that lost the race fails on the unique `(match_id, move_index)` key before it touches the event log.
- Rows are ordered by `seq` first. The first new `seq` MUST be the stored tail's `seq + 1` (`0` for an empty log) and the rest MUST be consecutive; anything else is rejected with an integrity error and nothing is written. This also catches a replay that no longer agrees with the stored log.
- The database enforces that a chain cannot fork: a unique index on `(match_id, prev_hash)` gives every event at most one successor. A second writer that read the same tail is rejected and its transaction rolls back, as a lost lease.
- The payload is normalised to what storage will return (a JSON round trip) before it is hashed, and the normalised value is what is stored. An event that cannot be hashed (for example an integer above 2^53) is an error, never stored without a hash.
- Resuming a match replays stored moves through the deterministic engine and appends from the next `seq`. Because the record depends only on event content, a resumed match produces the same chain as an uninterrupted one whenever the events themselves are identical.
- A match whose stored events have no hashes (it began before chaining existed) stays unchained to the end: new events are stored with `NULL` hashes. Hashes are never started partway through a log. Such a match is `UNVERIFIED`.
- If a match is restarted from nothing (the existing "clear stale events" step), the chain starts again at `genesis`.

### 4.5 The moves digest

Each model decision is also stored as a **move** (`MatchMove`): who moved, the raw move text, and a provenance record (section 5.1). The manifest commits to all moves with a second hash chain, so a stored move or its provenance cannot be edited later without detection.

```
moves_genesis = SHA-256( DOMAIN_MOVES_GENESIS || UTF8(match_id) )
move_hash(i)  = SHA-256( DOMAIN_MOVE || bytes(previous) || UTF8(canonical(record(i))) )      previous = moves_genesis for the first move
record(i)     = { "v": 1, "match_id": <id>, "move_index": i, "actor_role": <role>,
                  "content_sha256": <SHA-256 of the UTF-8 move text, hex>, "provenance": <the provenance record, or null> }
```

with `DOMAIN_MOVES_GENESIS = "arena-integrity/1/moves-genesis\n"` and `DOMAIN_MOVE = "arena-integrity/1/move"` followed by one `0x00` byte. `move_index` MUST be `0, 1, 2, …` with no gaps. The **moves head** is the last `move_hash`; for no moves it is `moves_genesis`. `provenance: null` means the move was recorded before provenance existed ("not recorded"), which is different from a record that says `unknown`.

The chain is built when the match is sealed (the signer reads the stored moves), so the moves table needs no per-row hash columns. A match with no moves has no moves digest.

## 5. Manifest

The manifest is a JSON object written once, when the match reaches a final status (`COMPLETED`, `FAILED` or `CANCELLED`).

| Field | Required | Meaning |
|---|---|---|
| `spec` | yes | The string `"arena-integrity/1"` |
| `key_id` | yes | Id of the signing key (section 6.1) |
| `match_id` | yes | The match id |
| `game_type` | yes | Game key, as stored |
| `ruleset_version` | yes | As stored |
| `seed` | yes | The integer match seed |
| `status` | yes | `COMPLETED`, `FAILED` or `CANCELLED` |
| `events` | yes | `{ "count": <integer>, "head_hash": <hash> }` from section 4.3 |
| `started_at` | yes | Timestamp or `null` |
| `finished_at` | yes | Timestamp or `null` |

Optional members, covered by the signature when present (defined by story m1-06):

| Member | Meaning |
|---|---|
| `engine` | Which game code ran: `{ "kind": "BUILT_IN" \| "NATIVE" \| "SANDBOXED", "key": <game key>, "artifact_id": <id or null>, "sha256": <64 hex>, "contract_version": <int, SANDBOXED only> }`. For `SANDBOXED` (generated) engines `sha256` is the SHA-256 of the artifact's source text (UTF-8); artifacts are written once per version, so it names exactly the code that ran. For `BUILT_IN` and `NATIVE` engines it is the entry for that engine in `src/integrity/engine-hashes.json`: a hash of the engine's source (line endings normalised to LF) and the installed version of each library it uses, regenerated by `scripts/hash-engines.mjs` and enforced by a test. The member is left out when the engine cannot be identified; it is never guessed. |
| `options` | The settings the match was created with, as stored: validated, clamped and merged with defaults by the create action, so these are the resolved settings. Omitted when the canonical JSON is larger than 16,384 characters; `options_sha256` is still present. The engine's own view of the settings it used (for example `max_plies`) is in the signed `MATCH_START` event. |
| `options_sha256` | SHA-256 of the canonical JSON of the stored options (`{}` when there are none). |

| `provenance` | `{ "v": 1, "moves": { "count": <int>, "head_hash": <64 hex> } }`: the moves digest of section 4.5. Present when the match has moves. |

Still reserved for later stories: `participants`. `seed` is a required member and records the match seed.

### 5.1 The per-move provenance record

Stored with each move (`MatchMove.provenance`, a JSON object) and committed to by the digest above. Every field holds a real value, an explicit marker, or `null` for a part that does not apply. A blank (`""`) or a missing field is never valid.

```json
{
  "v": 1,
  "source": "model",
  "prompt":   { "id": "chess/white", "version": "1.1.0", "sha256": "<hash of the exact system prompt>" },
  "model":    { "provider": "anthropic", "requested": "claude-example", "reported": "claude-example-20260101" },
  "sampling": { "temperature": 0, "max_tokens": 1024, "top_p": "provider-default" },
  "adapter":  "anthropic",
  "usage":    { "input_tokens": 812, "output_tokens": 9, "source": "provider" },
  "latency_ms": 1240,
  "cost":     { "usd": 0.002571, "basis": "provider-usage", "pricing": { "input_per_mtok": 3, "output_per_mtok": 15, "table_version": "2026-11-01" } },
  "response": { "sha256": "<hash of the full scrubbed response>", "bytes": 412, "truncated": false }
}
```

| Field | Meaning |
|---|---|
| `source` | `model` (a model call), `random` (the mock model: a seeded random legal move chosen by the engine) or `engine` (a move the engine made itself, such as a resolve step) |
| `prompt` | `id` is `<game key>/<role>`; `version` is the ruleset version the engine declared (`unknown` if it declared none); `sha256` is the SHA-256 of the exact system prompt sent. `null` for `random` and `engine` moves |
| `model` | `provider` and `requested` model id as configured; `reported` is the model or version string the provider echoed back, or `unknown`. For a composite model, `provider` and `requested` name the member that answered, `via` names the composite, and a pipeline adds `steps` listing every contributing step. `null` for `engine` moves |
| `sampling` | `temperature`, `max_tokens`, `top_p`: the number that was sent, `provider-default` (not sent, so the provider's own setting applied) or `unknown` (the adapter cannot tell). `null` for `random` and `engine` moves |
| `adapter` | the adapter that made the call, `unknown` if it did not say, `null` when there was no call |
| `usage` | tokens for the call: `source` is `provider` when the provider reported both counts, otherwise `estimated` (our own estimate; the counts are then marked as such). `null` for `random` and `engine` moves |
| `latency_ms` | wall-clock time of the model call as the runner measured it. `null` when there was no call. Two runs of the same match differ here by nature |
| `cost` | `usd` computed from `usage` and the price list in force (`src/config/model-pricing.json`); `pricing` records the rates and the table version that were applied, and `basis` says whether provider or estimated tokens were used, so the figure can be recomputed from the move alone. A model with no price, or without real token counts, is `{ "usd": "unknown", "basis": "unknown", "pricing": "unknown" }`, never zero. `null` when there was no call |
| `response` | digest of the raw provider response (section 5.2): `sha256` and `bytes` of the whole scrubbed response and whether the stored copy was `truncated`. `unknown` when the adapter keeps no response; `null` when there was no call |

### 5.2 Raw provider responses

For every model move the provider's response body is kept in `MoveRawResponse` (one row per move), and its digest is part of the move's provenance (`response`), so the signed moves digest commits to it.

- **Credentials are never stored.** Before anything is kept or hashed, the response is scrubbed: values under credential-named keys (`authorization`, `x-api-key`, `api_key`, `cookie`, `password`, `client_secret`, access and refresh tokens and similar, matched by exact name so usage fields such as `prompt_tokens` are untouched) are replaced with `[redacted]`; strings that look like credentials (`Bearer ...`, `sk-...`, Google and xAI keys) and the adapter's own API key wherever it appears are masked. Only the response body is kept, never request headers. The digest is taken over the scrubbed text, so it never depends on a secret.
- **Size limit and truncation marker.** The stored copy is at most 65,536 bytes of UTF-8, cut on a character boundary, with `truncated = true` and the true length in `bytes`. The database enforces the limit and that an untruncated copy is exactly `bytes` long. The digest in the provenance always covers the whole scrubbed response, so a truncated copy is consistent with it but cannot be re-hashed.
- **Retention.** Stored responses older than `INTEGRITY_RAW_RETENTION_DAYS` (default 90, `0` keeps them forever) are deleted by the per-minute sweeper. The digest stays in the signed moves, so verification is unaffected; a verifier that kept a copy can still check it against the digest.
- **Checking a stored response** is separate from verifying the match (`verifyRawResponses` in `src/integrity/verify.ts`): `verified` (the text hashes to the signed digest), `truncated` (consistent but cut), `missing` (deleted by retention, or never kept), `mismatch` (altered, or not this move's).

`unknown` and `provider-default` are markers, not blanks: they say why a value is missing. The runner records an adapter that cannot report anything as all `unknown`. What this proves is what the runner says it sent and what the provider said it ran; it is not independent evidence of the provider's behavior.


Limits worth knowing: a built-in engine's hash is the one in the table of the deployment that sealed the match, so a deploy that changes an engine while a match is running attributes that match to the new code (the runner's replay check still refuses to continue if the engine's behavior diverged). A hash proves which code ran, not that the code is correct.

Rules for extension: a verifier MUST ignore members it does not know; the signature covers all of them. Adding an optional member does not change the spec version: `engine`, `options` and `options_sha256` were added under `arena-integrity/1`, and a verifier that does not know them still verifies the match. Changing the meaning of a required member, a hash input or the verification procedure does.

The manifest is stored in `MatchManifest` (`src/services/match-manifest.service.ts`) and signed only when the match is final, no runner holds a live lease, and its stored chain re-verifies. While it exists the event log is sealed against further appends; retrying a match deletes it and the next final state signs a new one.

Failed and cancelled matches get a manifest like any other, with the matching `status`, so a partial log is still verifiable and is never mistaken for a completed one.

## 6. Signature and keys

### 6.1 Algorithm and key id

- Signature algorithm: **Ed25519** (RFC 8032), which is deterministic.
- Signed bytes: `DOMAIN_MANIFEST || UTF8(canonical(manifest))`.
- Key id: the first 8 bytes of `SHA-256(raw 32-byte public key)`, as 16 lowercase hex characters.
- The manifest contains `key_id`, and the signature envelope repeats it. They MUST be equal.

### 6.2 Envelope

```json
{
  "manifest": { },
  "signature": { "alg": "Ed25519", "key_id": "<16 hex>", "sig": "<base64url, no padding>" }
}
```

### 6.3 Published key set

Public keys are published as a JSON document at a stable URL (the exact URL is set by story m1-11):

```json
{ "keys": [ { "key_id": "<16 hex>", "alg": "Ed25519", "public_key": "<base64url raw 32 bytes>", "status": "active" } ] }
```

`status` is one of:
- `active`: used to sign new manifests.
- `retired`: no longer signs; signatures made while it was active remain valid. This is the normal state after a rotation.
- `revoked`: the key is believed compromised. Signatures by it MUST NOT be accepted.

The key set is kept in the repository at `src/integrity/published-keys.json`; keys are never removed from it. At most one key is `active`. Operations (creating, rotating and revoking keys) are in [INTEGRITY_KEYS.md](INTEGRITY_KEYS.md).

A bundle that carries its own key set is not a trust anchor. A verifier MUST obtain keys from a source it trusts (the published URL, or a key it was given directly).

## 7. Verification procedure

Inputs: the match id, all stored events for the match, an envelope, and a set of trusted keys. A verifier performs these checks **in this order** and stops at the first failure:

| # | Check | Failure code |
|---|---|---|
| 1 | The envelope has a manifest object and a signature object | `MALFORMED` |
| 2 | `manifest.spec` equals `arena-integrity/1` | `SPEC_UNSUPPORTED` |
| 3 | `manifest.match_id` equals the match id being verified | `MATCH_ID_MISMATCH` |
| 4 | The manifest can be canonicalized (section 3) | `MALFORMED` |
| 5 | Sorted by `seq`, the events have `seq` exactly `0 … n−1` | `EVENT_GAP` |
| 6 | `manifest.events.count` equals `n` | `EVENT_COUNT_MISMATCH` |
| 7 | Every event can be canonicalized, and the recomputed head (section 4.3) equals `manifest.events.head_hash` | `MALFORMED`, then `HEAD_MISMATCH` |
| 8 | The signature's `key_id` is in the trusted key set | `KEY_UNKNOWN` |
| 9 | That key's status is not `revoked` | `KEY_REVOKED` |
| 10 | `manifest.key_id` equals `signature.key_id`, and the Ed25519 signature verifies over the signed bytes | `SIGNATURE_INVALID` |

A verifier that also holds the match's moves performs an eleventh check, only when the manifest has `provenance.moves`:

| # | Check | Failure code |
|---|---|---|
| 11 | Sorted by `move_index`, the moves are numbered `0 … m−1`, `m` equals `provenance.moves.count`, and the recomputed moves head (section 4.5) equals `provenance.moves.head_hash` | `MOVES_MISMATCH` |

It runs after the signature check, so a forged manifest is reported as `SIGNATURE_INVALID`. A verifier that was not given the moves still returns `VERIFIED` but MUST say that the moves were not checked (the library returns `unchecked: ["moves"]`).

The result is `VERIFIED` only if all ten checks pass (and the eleventh, when it applies). A match that has **no manifest** (every match created before this spec is deployed) is `UNVERIFIED`, which is a different state from `FAILED`; verifiers and the site MUST NOT show it as verified, and MUST NOT backfill signatures for it.

Events may be supplied in any order; the verifier sorts them by `seq`.

## 8. Versioning

The version string is `arena-integrity/<major>`. A new major version is required for any change that makes a previously valid record verify differently. A verifier that sees a version it does not implement reports `SPEC_UNSUPPORTED` and does not guess.

## 9. Test vectors

[`integrity/test-vectors.json`](integrity/test-vectors.json) holds known answers for every section above: canonicalization (valid and rejected inputs), genesis hashes, hash chains (including the empty log), moves chains, test keys, and verification cases covering every failure code, including the moves digest. The keys in that file are **test keys** and MUST NOT be used for real signatures.

Every implementation MUST reproduce every vector. The production library is `src/integrity/verify.ts`: pure TypeScript with no database access and no Node or browser globals except `TextEncoder`, so the same code runs in Node (CLI, tests) and in a web page. The two crypto primitives (SHA-256 and Ed25519 verification) are injected: `nodeProvider` (`verify-node.ts`) and `webProvider` (`verify-web.ts`, WebCrypto; Ed25519 needs Chrome 137, Firefox 129 or Safari 17). Where Ed25519 is unavailable the library reports `ERROR`, never a pass.

```ts
import { verifyMatch } from './integrity/verify';
import { nodeProvider } from './integrity/verify-node';   // or webProvider from './integrity/verify-web'
const outcome = await verifyMatch(nodeProvider, matchId, events, envelope /* or null */, trustedKeys);
// { result: 'VERIFIED' } | { result: 'UNVERIFIED' } | { result: 'FAILED', code, detail? } | { result: 'ERROR', code }
```

The file is checked by `tests/integrity-spec.test.ts` (reference implementation), `tests/integrity-verify.test.ts` (the library with both providers, a tamper matrix, and 600 random mutations compared with the reference) and `tests/browser/integrity-verify.browser.test.ts` (a real browser). The same values were also re-derived with an independent implementation (Python, `hashlib` and `cryptography`) before publishing.

Regenerating after an intentional spec change: `UPDATE_INTEGRITY_VECTORS=1 npx jest tests/integrity-spec.test.ts`, then bump the spec version if verification rules changed.

## 10. Open items handed to later stories

- Done: storage columns (m1-02) and chaining on every append path with the no-fork index (m1-03).
- Done: the verification library (m1-05).
- Done: engine hash, settings and seed in the manifest (m1-06).
- Done: signing at match completion with an environment-held key behind a `Signer` interface, rotation and revocation (m1-04). Still open: provisioning the production key and publishing it (docs/INTEGRITY_KEYS.md).
- Done: per-move provenance and the moves digest (m1-07).
- Done: raw provider responses, tokens, latency and cost per move (m1-08). Still open: the price list in `src/config/model-pricing.json` is empty until someone fills it from a provider price list.
- m1-11: the key-set URL and the export bundle format.
