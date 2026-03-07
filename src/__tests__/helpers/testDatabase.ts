import { newDb } from "pg-mem";
import { getDatabase, type DatabaseClient } from "../../db/database";

export async function createTestDatabase(): Promise<DatabaseClient> {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return getDatabase({ pool });
}
