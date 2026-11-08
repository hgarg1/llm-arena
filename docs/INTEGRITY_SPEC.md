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
- That the models answered the way the log says. The log records what the runner stored. Raw provider responses and usage numbers are added by later stories (m1-07, m1-08) and are covered by the manifest once they are.
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

Reserved for later stories; when present they are covered by the signature: `engine` (artifact id and content hash, story m1-06), `options_sha256`, `participants`, `provenance` (prompt, model and sampling information, raw-response digests, stories m1-07 and m1-08).

Rules for extension: a verifier MUST ignore members it does not know; the signature covers all of them. Adding an optional member does not change the spec version. Changing the meaning of a required member, a hash input or the verification procedure does.

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

The result is `VERIFIED` only if all ten checks pass. A match that has **no manifest** (every match created before this spec is deployed) is `UNVERIFIED`, which is a different state from `FAILED`; verifiers and the site MUST NOT show it as verified, and MUST NOT backfill signatures for it.

Events may be supplied in any order; the verifier sorts them by `seq`.

## 8. Versioning

The version string is `arena-integrity/<major>`. A new major version is required for any change that makes a previously valid record verify differently. A verifier that sees a version it does not implement reports `SPEC_UNSUPPORTED` and does not guess.

## 9. Test vectors

[`integrity/test-vectors.json`](integrity/test-vectors.json) holds known answers for every section above: canonicalization (valid and rejected inputs), genesis hashes, hash chains (including the empty log), test keys, and 14 verification cases covering each failure code. The keys in that file are **test keys** and MUST NOT be used for real signatures.

Every implementation (the production verifier in story m1-05, the CLI in m1-13, the browser verifier in m1-12) MUST reproduce every vector. The file is checked by `tests/integrity-spec.test.ts`, and the same values were also re-derived with an independent implementation (Python, `hashlib` and `cryptography`) before publishing.

Regenerating after an intentional spec change: `UPDATE_INTEGRITY_VECTORS=1 npx jest tests/integrity-spec.test.ts`, then bump the spec version if verification rules changed.

## 10. Open items handed to later stories

- Done: storage columns (m1-02) and chaining on every append path with the no-fork index (m1-03).
- Done: signing at match completion with an environment-held key behind a `Signer` interface, rotation and revocation (m1-04). Still open: provisioning the production key and publishing it (docs/INTEGRITY_KEYS.md).
- m1-06, m1-07, m1-08: the reserved manifest members.
- m1-11: the key-set URL and the export bundle format.
