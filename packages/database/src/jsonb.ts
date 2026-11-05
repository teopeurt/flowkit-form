import type { JSONValue, Sql } from 'postgres';

/**
 * Binds a value as real `jsonb`.
 *
 * Interpolating `JSON.stringify(value)` with a `::jsonb` cast is not equivalent: it stores a JSON
 * *string* scalar, so `jsonb_typeof` reports `string` and every `->`/`->>` read of the column
 * silently returns null. The round-trip here also drops values JSON cannot represent, which is what
 * the column can hold anyway.
 */
export function jsonb(sql: Sql, value: unknown) {
  return sql.json(JSON.parse(JSON.stringify(value ?? null)) as JSONValue);
}
