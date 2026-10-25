import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QueryResult, QueryResultRow } from 'pg';
import { SqlClient, SqlDatabase } from '../../apps/api/src/runs/run-domain';

// PGlite executes real PostgreSQL SQL in one backend. Serialize leases to keep
// complete transactions together. This does not simulate multi-server timing.
export class EmbeddedPostgres implements SqlDatabase {
  readonly engine = new PGlite();
  private tail: Promise<void> = Promise.resolve();

  async migrate(): Promise<void> {
    for (const file of (await readdir(join(process.cwd(), 'database/migrations'))).filter((file) => file.endsWith('.sql')).sort()) {
      await this.engine.exec(await readFile(join(process.cwd(), 'database/migrations', file), 'utf8'));
    }
  }

  async connect(): Promise<SqlClient> {
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    return {
      query: async <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> => {
        const result = await this.engine.query<R>(text, values);
        return { rows: result.rows, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length,
          command: result.command ?? '', fields: [], oid: 0 };
      },
      release: unlock,
    };
  }

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    const client = await this.connect();
    try { return await client.query<R>(text, values); } finally { client.release(); }
  }
}
