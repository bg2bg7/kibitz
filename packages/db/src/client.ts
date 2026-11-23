import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export type SuiteDatabase = NodePgDatabase<typeof schema>;

export interface DbClientHandle {
  db: SuiteDatabase;
  pool: Pool;
  close: () => Promise<void>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../drizzle");
const MIGRATION_ADVISORY_LOCK_KEY = 42190837;

/**
 * Factory creating a pooled Drizzle ORM PostgreSQL client.
 */
export function createDbClient(connectionString: string): DbClientHandle {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

/**
 * Applies any pending Drizzle SQL migrations from `packages/db/drizzle` on a dedicated
 * PostgreSQL connection guarded by a session advisory lock so concurrent service startups never race.
 */
export async function runSuiteMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      const migrationDb = drizzle(client, { schema });
      await migrate(migrationDb, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
