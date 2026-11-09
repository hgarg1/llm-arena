/**
 * Canonical JSON (RFC 8785 profile, docs/INTEGRITY_SPEC.md section 3). Pure: no imports, no Node or browser APIs, so the
 * same file runs in the runner, the verifier, the CLI and a web page.
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Canonical JSON (RFC 8785 profile, spec section 3). Throws CanonicalizationError for anything outside the profile. */
export const canonicalize = (value: unknown): string => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError('non-finite number');
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new CanonicalizationError('integer outside the safe range');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new CanonicalizationError('lone surrogate');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalizationError('not a plain object');
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(); // default sort compares UTF-16 code units, as the profile requires
      for (const key of keys) if (record[key] === undefined) throw new CanonicalizationError(`undefined value at "${key}"`);
      return `{${keys.map(key => `${canonicalize(key)}:${canonicalize(record[key])}`).join(',')}}`;
    }
    default:
      throw new CanonicalizationError(`unsupported type ${typeof value}`);
  }
};
