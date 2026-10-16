import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from '../packages/db/src/index';
/** Explicit operator action, never automatic during server startup. */
async function main() {
  const database=createDatabase(process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || '');
  try {
    await migrate(database.db,{migrationsFolder:fileURLToPath(new URL('../packages/db/drizzle/',import.meta.url))});
    console.log('Database migrations applied.');
  } finally {await database.close();}
}
main().catch(()=>{console.error('Migration failed. Check database access and migration baseline; connection details suppressed.');process.exitCode=1;});
