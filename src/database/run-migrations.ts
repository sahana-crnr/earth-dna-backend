// Applies any pending TypeORM migrations, then exits.
//
// Run automatically by the container on startup (see the Dockerfile CMD), so a
// deploy can never serve traffic against an un-migrated schema. Exits non-zero
// on failure, which makes the `&&` in the CMD stop the app from starting.
import { AppDataSource } from './data-source';

// Any fixed 32-bit integer. Every task must use the SAME value so they compete
// for the same lock.
const MIGRATION_LOCK_KEY = 727301;

async function main(): Promise<void> {
  const ds = await AppDataSource.initialize();

  // ECS starts every task in a service at the same moment, and TypeORM has no
  // locking of its own - concurrent runMigrations() calls can double-apply or
  // deadlock. A Postgres advisory lock serialises them: the first task migrates,
  // the others wait, acquire the lock, find nothing pending, and move on.
  //
  // The lock is held on this session only and is released automatically if the
  // process dies, so a crashed task cannot block future deploys.
  await ds.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

  try {
    const ran = await ds.runMigrations();
    console.log(
      ran.length === 0
        ? 'Migrations complete — nothing pending'
        : `Migrations complete — ${ran.length} executed: ${ran
            .map((m) => m.name)
            .join(', ')}`,
    );
  } finally {
    await ds.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  // Non-zero exit stops the container starting the app against a bad schema.
  process.exit(1);
});
