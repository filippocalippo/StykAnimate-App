// Development/test adapter: executes the actual migration and production SQL in SQLite.
// D1 usage metadata is unavailable locally; never presents SQLite row counts as billed D1 usage.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function createLocalDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./migrations/0001_analytics.sql', import.meta.url), 'utf8'));
  function prepare(sql) {
    let parameters = [];
    const statement = {
      bind(...values) { parameters = values; return statement; },
      async all() { return { results: db.prepare(sql).all(...parameters), success: true, meta: {} }; },
      async first(column) { const row = db.prepare(sql).get(...parameters); return column ? row?.[column] ?? null : row ?? null; },
      async run() { const result = db.prepare(sql).run(...parameters); return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
      async raw() { return (await statement.all()).results.map(Object.values); }
    };
    return statement;
  }
  return { prepare, async batch(statements) { db.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.all()); db.exec('COMMIT'); return results; } catch (error) { db.exec('ROLLBACK'); throw error; } }, async exec(sql) { db.exec(sql); return { count: 1, duration: 0 }; }, close() { db.close(); }, _sqlite: db };
}
