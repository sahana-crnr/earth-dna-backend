import { AppDataSource } from './data-source';

AppDataSource.initialize()
  .then(async (ds) => {
    const ran = await ds.runMigrations();
    console.log(`Migrations complete — ${ran.length} executed`);
    await ds.destroy();
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
