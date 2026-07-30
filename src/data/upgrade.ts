import { ENTITY_TABLES, db, type EntityTableName } from './db';
import type { BaseEntity } from './types';
import {
  DATA_VERSION,
  DATA_VERSION_KEY,
  PRE_MIGRATION_SNAPSHOT_KEY,
  isFromFuture,
  migrateTables,
  type MigratableTables,
} from './migrations';

/**
 * Runs data-content migrations against the live database at startup.
 *
 * Before writing anything it stores a metadata snapshot in `settings`, so a
 * buggy future migration is recoverable even for someone who never exported a
 * backup. Photo blobs are excluded — migrations never touch image bytes, and
 * duplicating them would double storage on the platform that has least of it.
 */

export type UpgradeStatus =
  | { kind: 'fresh' }
  | { kind: 'current'; version: number }
  | { kind: 'migrated'; from: number; to: number; applied: string[] }
  | { kind: 'from-future'; stored: number; supported: number }
  | { kind: 'failed'; error: string; snapshotKept: boolean };

interface Snapshot {
  takenAt: string;
  version: number;
  tables: MigratableTables;
}

function tableOf(name: EntityTableName) {
  return db[name] as unknown as import('dexie').Table<BaseEntity, string>;
}

async function readAllTables(): Promise<MigratableTables> {
  const out = {} as MigratableTables;
  for (const name of ENTITY_TABLES) out[name] = await tableOf(name).toArray();
  return out;
}

async function isDatabaseEmpty(): Promise<boolean> {
  for (const name of ENTITY_TABLES) {
    if ((await tableOf(name).count()) > 0) return false;
  }
  return true;
}

export async function runDataUpgrade(): Promise<UpgradeStatus> {
  const storedRaw = await db.settings.get(DATA_VERSION_KEY);
  const stored = typeof storedRaw?.value === 'number' ? storedRaw.value : null;

  // A database with no version marker is either brand new, or was written by
  // the release that shipped before versioning existed. Both are format v1 —
  // but only the empty one may be stamped as current right away. Stamping a
  // populated pre-versioning database before migrating it would label v1 rows
  // as already up to date and skip the upgrade entirely.
  if (stored === null && (await isDatabaseEmpty())) {
    await db.settings.put({ key: DATA_VERSION_KEY, value: DATA_VERSION });
    return { kind: 'fresh' };
  }

  const from = stored ?? 1;

  if (isFromFuture(from)) {
    // Someone opened an older build against newer data (a rolled-back deploy).
    // Leave every row exactly as it is rather than risk destroying fields this
    // build does not understand.
    return { kind: 'from-future', stored: from, supported: DATA_VERSION };
  }

  if (from >= DATA_VERSION) {
    // Record the marker for a pre-versioning install that needs no upgrade, so
    // this detection only ever runs once.
    if (stored === null) await db.settings.put({ key: DATA_VERSION_KEY, value: from });
    return { kind: 'current', version: from };
  }

  const before = await readAllTables();
  const snapshot: Snapshot = { takenAt: new Date().toISOString(), version: from, tables: before };

  try {
    // Snapshot first, in its own transaction, so it survives a failure below.
    await db.settings.put({ key: PRE_MIGRATION_SNAPSHOT_KEY, value: snapshot });

    const outcome = migrateTables(before, from);

    await db.transaction(
      'rw',
      [...ENTITY_TABLES.map(tableOf), db.settings],
      async () => {
        for (const name of ENTITY_TABLES) {
          // Replace wholesale: a migration may legitimately drop or merge rows,
          // and bulkPut alone would leave the removed ones behind.
          await tableOf(name).clear();
          await tableOf(name).bulkPut(outcome.tables[name]);
        }
        await db.settings.put({ key: DATA_VERSION_KEY, value: outcome.to });
      },
    );

    return { kind: 'migrated', from, to: outcome.to, applied: outcome.applied };
  } catch (error) {
    console.error('data migration failed', error);
    return {
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
      snapshotKept: true,
    };
  }
}

export interface SnapshotInfo {
  takenAt: string;
  version: number;
  cards: number;
}

/** Details of the automatic pre-migration snapshot, for display in 設定. */
export async function getSnapshotInfo(): Promise<SnapshotInfo | null> {
  const row = await db.settings.get(PRE_MIGRATION_SNAPSHOT_KEY);
  const snap = row?.value as Snapshot | undefined;
  if (!snap?.tables) return null;
  return {
    takenAt: snap.takenAt,
    version: snap.version,
    cards: snap.tables.cards?.length ?? 0,
  };
}

/**
 * Hand the pre-migration state back as an ordinary backup zip.
 *
 * Deliberately *not* a write back into the live database. Doing that would set
 * the stored version marker backwards, and the next startup would simply run
 * the same migration again and land in exactly the same place — a restore that
 * silently does nothing. Producing a file instead is both honest and more
 * useful: it is durable, inspectable, movable to another device, and importable
 * once a corrected version of the migration ships.
 *
 * Photos are read live rather than from the snapshot, because migrations never
 * touch image bytes — so the file is a complete, self-contained backup.
 */
export async function exportPreMigrationSnapshot(): Promise<{
  blob: Blob;
  filename: string;
} | null> {
  const row = await db.settings.get(PRE_MIGRATION_SNAPSHOT_KEY);
  const snap = row?.value as Snapshot | undefined;
  if (!snap?.tables) return null;

  const { buildBackupZip } = await import('./backup');
  const referenced = new Set<string>();
  for (const card of snap.tables.cards ?? []) {
    const c = card as { frontPhotoId?: string; backPhotoId?: string };
    if (c.frontPhotoId) referenced.add(c.frontPhotoId);
    if (c.backPhotoId) referenced.add(c.backPhotoId);
  }
  const photos = (await db.photos.toArray()).filter((p) => referenced.has(p.id));

  return buildBackupZip(
    snap.tables,
    await db.settings.toArray(),
    photos,
    snap.version,
    // ASCII only: Chromium discards a `download` attribute that is entirely
    // non-ASCII and saves the file as "download" with no extension.
    `-pre-upgrade-v${snap.version}`,
  );
}

export async function discardPreMigrationSnapshot(): Promise<void> {
  await db.settings.delete(PRE_MIGRATION_SNAPSHOT_KEY);
}
