/**
 * Which game code produced a match (manifest member `engine`, docs/INTEGRITY_SPEC.md section 5).
 *  - SANDBOXED: a generated engine. `sha256` is the SHA-256 of the artifact's source text; artifacts are written once per
 *    version, so the hash names exactly the code that ran.
 *  - BUILT_IN / NATIVE: an engine shipped in this repository. `sha256` comes from src/integrity/engine-hashes.json, which
 *    covers the engine's source and the installed versions of the libraries it uses (scripts/hash-engines.mjs keeps it
 *    current; a test fails if an engine changes without it).
 */
import { createHash } from 'crypto';
import hashes from './engine-hashes.json';

export type EngineKind = 'BUILT_IN' | 'NATIVE' | 'SANDBOXED';

export interface EngineIdentity {
  kind: EngineKind;
  /** The game key the match was played under. */
  key: string;
  artifact_id: string | null;
  /** 64 lowercase hex characters. */
  sha256: string;
  /** Present for SANDBOXED engines: the contract version the generated code targets. */
  contract_version?: number;
}

export interface ArtifactForIdentity {
  id: string;
  kind: 'NATIVE' | 'SANDBOXED';
  native_key: string | null;
  code_ts: string;
  contract_version: number;
}

const TABLE = hashes as Record<string, { sha256: string }>;

export const builtInEngineHash = (key: string): string | null => TABLE[key]?.sha256 ?? null;
export const builtInEngineKeys = (): string[] => Object.keys(TABLE);

/** SHA-256 of the generated engine's source text (UTF-8). Anyone holding the artifact can recompute it. */
export const sandboxedEngineHash = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex');

/**
 * The identity of the engine a match ran, or null when it cannot be established (an engine that is not built in and has
 * no pinned artifact). Null means "not recorded", never a guess.
 */
export const engineIdentity = (gameType: string, artifact: ArtifactForIdentity | null): EngineIdentity | null => {
  if (!artifact) {
    const sha256 = builtInEngineHash(gameType);
    return sha256 ? { kind: 'BUILT_IN', key: gameType, artifact_id: null, sha256 } : null;
  }
  if (artifact.kind === 'NATIVE') {
    const sha256 = builtInEngineHash(artifact.native_key || gameType);
    return sha256 ? { kind: 'NATIVE', key: gameType, artifact_id: artifact.id, sha256 } : null;
  }
  return { kind: 'SANDBOXED', key: gameType, artifact_id: artifact.id, sha256: sandboxedEngineHash(artifact.code_ts), contract_version: artifact.contract_version };
};
