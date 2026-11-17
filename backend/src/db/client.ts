import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { getConfig } from '../config/env.js';

const { Pool } = pg;

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface DbDriver {
  readonly engine: 'postgresql' | 'pglite-postgresql';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: (sql: string, params?: unknown[]) => Promise<QueryResult>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PostgresPoolDriver implements DbDriver {
  readonly engine = 'postgresql' as const;
  private pool: pg.Pool;

  constructor(connectionString: string, useSsl: boolean, isServerless = false) {
    const isSupabase = connectionString.includes('supabase.co') || connectionString.includes('supabase.com');
    this.pool = new Pool({
      connectionString,
      ssl: useSsl || isSupabase ? { rejectUnauthorized: false } : undefined,
      max: isServerless ? 3 : 12,
      idleTimeoutMillis: isServerless ? 15_000 : 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(
    fn: (tx: (sql: string, params?: unknown[]) => Promise<QueryResult>) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
        const res = await client.query(sql, params);
        return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PGliteDriver implements DbDriver {
  readonly engine = 'pglite-postgresql' as const;
  private db: PGlite;
  private txChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    if (dataDir === 'memory://') {
      this.db = new PGlite();
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
      this.db = new PGlite(dataDir);
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.db.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(
    fn: (tx: (sql: string, params?: unknown[]) => Promise<QueryResult>) => Promise<T>
  ): Promise<T> {
    // Serialize transactions cleanly on single-connection embedded PostgreSQL
    const run = async (): Promise<T> => {
      return this.db.transaction(async (pgliteTx) => {
        const tx = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
          const res = await pgliteTx.query<Record<string, unknown>>(sql, params);
          return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
        };
        return fn(tx);
      });
    };
    const next = this.txChain.then(run, run);
    this.txChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

let activeDriver: DbDriver | null = null;
let initPromise: Promise<DbDriver> | null = null;

function readSchemaSql(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(currentDir, 'schema.sql');
  if (fs.existsSync(candidate)) {
    return fs.readFileSync(candidate, 'utf8');
  }
  const srcFallback = path.resolve(currentDir, '../../src/db/schema.sql');
  return fs.readFileSync(srcFallback, 'utf8');
}

export async function initDatabase(): Promise<DbDriver> {
  if (activeDriver) return activeDriver;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const config = getConfig();
    const driver: DbDriver = config.databaseUrl
      ? new PostgresPoolDriver(config.databaseUrl, config.databaseSsl, config.isVercel)
      : new PGliteDriver(config.pgliteDataDir);

    const schemaSql = readSchemaSql();
    await driver.exec(schemaSql);
    activeDriver = driver;
    return driver;
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

export function getDb(): DbDriver {
  if (!activeDriver) {
    throw new Error('Database not initialized. Call initDatabase() before querying.');
  }
  return activeDriver;
}

export async function listPublicTables(): Promise<string[]> {
  const db = await initDatabase();
  const res = await db.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name ASC`
  );
  return res.rows.map((r) => r.table_name);
}

export async function closeDatabase(): Promise<void> {
  if (activeDriver) {
    const d = activeDriver;
    activeDriver = null;
    initPromise = null;
    await d.close();
  }
}
