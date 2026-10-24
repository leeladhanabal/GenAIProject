require('dotenv/config');

const { readdir, readFile } = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    throw new Error('Set DATABASE_URL or PGHOST before running migrations');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'ai_performance_agent',
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD,
    ssl:
      process.env.PGSSLMODE === 'require'
        ? { rejectUnauthorized: true }
        : undefined,
    connectionTimeoutMillis: 5000,
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const migrationDirectory = path.resolve(__dirname, '..', 'database', 'migrations');
    const migrationNames = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const name of migrationNames) {
      const existing = await pool.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [name],
      );
      if (existing.rowCount > 0) {
        console.log(`Already applied: ${name}`);
        continue;
      }

      const sql = await readFile(path.join(migrationDirectory, name), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
          name,
        ]);
        await client.query('COMMIT');
        console.log(`Applied: ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
