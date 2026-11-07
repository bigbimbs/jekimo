/**
 * Returns the first row of a query that must produce one (INSERT ... RETURNING,
 * count(*)). A missing row means the database did not do what the SQL
 * promised, so it is an internal error, not a client error.
 */
export function firstRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a row from ${what}`);
  return row;
}
