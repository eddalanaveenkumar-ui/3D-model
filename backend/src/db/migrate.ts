import { closeDatabase, initDatabase, listPublicTables } from './client.js';

async function main() {
  const db = await initDatabase();
  const tables = await listPublicTables();
  console.log(`[NV3D DB] Migrated successfully using engine "${db.engine}".`);
  console.log(`[NV3D DB] Verified tables (${tables.length}): ${tables.join(', ')}`);
  await closeDatabase();
}

main().catch((err) => {
  console.error('[NV3D DB] Migration failed:', err);
  process.exit(1);
});
