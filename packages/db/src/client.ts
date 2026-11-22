import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export type SuiteDatabase = NodePgDatabase<typeof schema>;

export interface DbClientHandle {
  db: SuiteDatabase;
  pool: Pool;
  close: () => Promise<void>;
}

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
