// Shared `--json` serializer (T3.1 + T3.2). Every command's `--json` output
// goes through this so the Date/undefined handling stays consistent.
//
// Date handling: Dates serialize to their ISO-8601 string (`toISOString()`).
// JSON.stringify already does this implicitly (Date.prototype.toJSON calls
// toISOString), but that's made explicit here via a replacer rather than
// relied on silently, so a future Session-shaped type that carries a
// Date-like value WITHOUT a real Date instance (e.g. a plain
// `{ toISOString }` duck) is not accidentally covered by this contract.
//
// Key order: NOT sorted/deterministic by design — this walks object own-keys
// in normal JS insertion order (whatever order the source object literal /
// spread produced), matching JSON.stringify's own behavior. Callers that
// need byte-stable output across runs (e.g. snapshot tests) should assert on
// parsed structure, not the raw string, unless the producing object's key
// order is itself stable (it usually is, since USM types are built via
// fixed-shape object literals).

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** Serializes `value` for `--json` output: 2-space indent, Dates -> ISO
 * strings, undefined properties omitted (JSON.stringify's normal behavior). */
export function serializeJSON(value: unknown): string {
  return JSON.stringify(value, jsonReplacer, 2);
}
