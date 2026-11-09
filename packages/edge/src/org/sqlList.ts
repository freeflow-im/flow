// IN lists for the Org object's database. Durable Object SQLite allows about 100 bound parameters per statement, and
// drizzle's `inArray(column, values)` binds one per value, so a list as long as a person's channels throws "too many SQL
// variables". These bind the whole list as one JSON string and read it back with `json_each`, whatever its length.
import { sql, type Column, type SQL } from 'drizzle-orm';

type ListValue = string | number;

/** The list as one JSON string of the column's driver values (a column with its own mapping maps each value first), so
 * `json_each` yields what the column holds. */
function bound(column: Column, values: readonly ListValue[]): string {
  return JSON.stringify(values.map((v) => column.mapToDriverValue(v)));
}

/** `column IN (values)` with one bound variable; an empty list is false, as drizzle's `inArray` with `[]`. */
export function inList(column: Column, values: readonly ListValue[]): SQL {
  if (values.length === 0) return sql`false`;
  return sql`${column} in (select value from json_each(${bound(column, values)}))`;
}
