import type { Table } from 'dexie';
import { unzip, zip, strFromU8, strToU8, type Zippable } from 'fflate';
import { ENTITY_TABLES, db, type EntityTableName } from './db';
import { invalidatePhotoUrl } from './photos';
import type { AppSetting, BaseEntity, ID, Photo } from './types';
import {
  DATA_VERSION,
  DATA_VERSION_KEY,
  PRE_MIGRATION_SNAPSHOT_KEY,
  isFromFuture,
  migrateTables,
} from './migrations';

/**
 * Backup treats every entity table alike, but each has its own row type, so
 * indexing `db` by name produces a union Dexie's overloads can't resolve.
 * One widening helper keeps the casting in a single place.
 */
type AnyEntityTable = Table<BaseEntity, ID>;
const tableFor = (name: EntityTableName): AnyEntityTable =>
  db[name] as unknown as AnyEntityTable;

/**
 * Zip backup — the cross-device transfer route and the answer to iOS clearing
 * site storage. Everything the app knows goes in: metadata as JSON, photos as
 * their original compressed bytes.
 */

/**
 * Version of the zip *container* — the file layout and manifest shape. Separate
 * from `DATA_VERSION`, which versions the rows inside. A release can change one
 * without touching the other.
 */
export const BACKUP_VERSION = 1;

interface PhotoMeta extends Omit<Photo, 'blob' | 'thumbBlob'> {
  /** Extension is informational; the reader trusts `mime`. */
  file: string;
  thumbFile: string;
}

interface BackupManifest {
  version: number;
  /** Row-format version, so an old backup can be migrated on import. Absent in
   *  the very first release's files, which were all format v1. */
  dataVersion?: number;
  exportedAt: string;
  app: string;
  counts: Record<string, number>;
  tables: Record<EntityTableName, BaseEntity[]>;
  settings: AppSetting[];
  photos: PhotoMeta[];
}

function zipAsync(files: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, files) => (err ? reject(err) : resolve(files)));
  });
}

/**
 * Package a set of rows plus the photos they reference into a backup zip.
 *
 * Split out from `exportBackup` so the pre-migration snapshot can be handed to
 * the user as an ordinary, importable backup file rather than a special format
 * only this app version understands.
 */
export async function buildBackupZip(
  tables: Record<EntityTableName, BaseEntity[]>,
  settings: AppSetting[],
  photos: Photo[],
  dataVersion: number,
  filenameSuffix = '',
): Promise<{ blob: Blob; filename: string }> {
  const files: Zippable = {};
  const photoMeta: PhotoMeta[] = [];

  for (const photo of photos) {
    const ext = photo.mime.includes('png') ? 'png' : photo.mime.includes('jpeg') ? 'jpg' : 'webp';
    const file = `photos/${photo.id}.${ext}`;
    const thumbFile = `photos/${photo.id}.thumb.${ext}`;
    // Already-compressed image bytes: storing them raw is both faster and
    // smaller than asking DEFLATE to try again.
    files[file] = [new Uint8Array(await photo.blob.arrayBuffer()), { level: 0 }];
    files[thumbFile] = [new Uint8Array(await photo.thumbBlob.arrayBuffer()), { level: 0 }];
    const { blob: _b, thumbBlob: _t, ...rest } = photo;
    photoMeta.push({ ...rest, file, thumbFile });
  }

  const manifest: BackupManifest = {
    version: BACKUP_VERSION,
    dataVersion,
    exportedAt: new Date().toISOString(),
    app: '小卡櫃',
    counts: {
      cards: tables.cards?.length ?? 0,
      photos: photoMeta.length,
    },
    tables,
    settings,
    photos: photoMeta,
  };
  files['data.json'] = strToU8(JSON.stringify(manifest));

  const zipped = await zipAsync(files);
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    // `slice()` gives a plain ArrayBuffer — some TS DOM builds reject the
    // SharedArrayBuffer-capable view type that fflate returns.
    blob: new Blob([zipped.slice().buffer as ArrayBuffer], { type: 'application/zip' }),
    // ASCII on purpose. Chromium discards an all-CJK `download` attribute and
    // saves the file as "download" with no extension, and non-ASCII names also
    // travel badly over AirDrop and cloud drives.
    filename: `pocabox-backup-${stamp}${filenameSuffix}.zip`,
  };
}

export async function exportBackup(): Promise<{ blob: Blob; filename: string }> {
  const tables = {} as Record<EntityTableName, BaseEntity[]>;
  for (const name of ENTITY_TABLES) {
    tables[name] = await tableFor(name).toArray();
  }
  return buildBackupZip(
    tables,
    await db.settings.toArray(),
    await db.photos.toArray(),
    DATA_VERSION,
  );
}

export type ImportMode = 'replace' | 'merge';

export interface ImportResult {
  mode: ImportMode;
  cards: number;
  photos: number;
  skipped: number;
  /** Upgrade steps applied to the file's rows, if it came from an older format. */
  migrated: string[];
}

export async function readBackupManifest(file: File): Promise<BackupManifest> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await unzipAsync(bytes);
  const raw = entries['data.json'];
  if (!raw) throw new Error('這個檔案裡沒有 data.json，可能不是小卡櫃的備份檔');
  const manifest = JSON.parse(strFromU8(raw)) as BackupManifest;
  if (manifest.version > BACKUP_VERSION) {
    throw new Error('這個備份來自較新版本的小卡櫃，請先更新 App 再匯入');
  }
  if (!manifest.tables) throw new Error('備份檔內容不完整');
  return manifest;
}

export async function importBackup(file: File, mode: ImportMode): Promise<ImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await unzipAsync(bytes);
  const raw = entries['data.json'];
  if (!raw) throw new Error('這個檔案裡沒有 data.json，可能不是小卡櫃的備份檔');
  const manifest = JSON.parse(strFromU8(raw)) as BackupManifest;
  if (manifest.version > BACKUP_VERSION) {
    throw new Error('這個備份來自較新版本的小卡櫃，請先更新 App 再匯入');
  }
  const fileDataVersion = manifest.dataVersion ?? 1;
  if (isFromFuture(fileDataVersion)) {
    throw new Error('這個備份的資料格式比這個版本的小卡櫃新，請先更新 App 再匯入');
  }

  // Bring the file's rows up to the current format and enforce every invariant
  // before a single one reaches the database. An older backup is upgraded by
  // exactly the same steps that live data goes through on startup, so both
  // paths can never drift apart.
  const upgraded = migrateTables(manifest.tables ?? {}, fileDataVersion);

  const photoRows: Photo[] = manifest.photos.map((meta) => {
    const full = entries[meta.file];
    const thumb = entries[meta.thumbFile] ?? full;
    if (!full) throw new Error(`備份檔缺少照片 ${meta.id}`);
    const { file: _f, thumbFile: _tf, ...rest } = meta;
    return {
      ...rest,
      blob: new Blob([full.slice().buffer as ArrayBuffer], { type: meta.mime }),
      thumbBlob: new Blob([thumb.slice().buffer as ArrayBuffer], { type: meta.mime }),
    };
  });

  let skipped = 0;

  await db.transaction(
    'rw',
    [...ENTITY_TABLES.map(tableFor), db.photos, db.settings],
    async () => {
      if (mode === 'replace') {
        for (const name of ENTITY_TABLES) await tableFor(name).clear();
        await db.photos.clear();
        for (const name of ENTITY_TABLES) {
          await tableFor(name).bulkPut(upgraded.tables[name] ?? []);
        }
        await db.photos.bulkPut(photoRows);
      } else {
        // Merge: an incoming row wins only when it is strictly newer, which is
        // the same last-write-wins rule cloud sync will use.
        for (const name of ENTITY_TABLES) {
          for (const row of upgraded.tables[name] ?? []) {
            const existing = await tableFor(name).get(row.id);
            if (existing && existing.updatedAt >= row.updatedAt) {
              skipped += 1;
              continue;
            }
            await tableFor(name).put(row);
          }
        }
        for (const photo of photoRows) {
          const existing = await db.photos.get(photo.id);
          if (existing && existing.updatedAt >= photo.updatedAt) continue;
          await db.photos.put(photo);
        }
      }

      for (const setting of manifest.settings ?? []) {
        // Never let the file's own bookkeeping overwrite ours: restoring an old
        // `dataVersion` would mark freshly-migrated rows as un-migrated, and a
        // snapshot from another device is meaningless here.
        if (setting.key === DATA_VERSION_KEY || setting.key === PRE_MIGRATION_SNAPSHOT_KEY) {
          continue;
        }
        await db.settings.put(setting);
      }
      await db.settings.put({ key: DATA_VERSION_KEY, value: DATA_VERSION });
    },
  );

  // Cached object URLs may now point at replaced blobs.
  for (const photo of photoRows) invalidatePhotoUrl(photo.id);

  return {
    mode,
    cards: upgraded.tables.cards?.length ?? 0,
    photos: photoRows.length,
    skipped,
    migrated: upgraded.applied,
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give Safari a moment to start the download before the URL disappears.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Wipe every table. Used by 設定 → 清除所有資料. */
export async function clearAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [...ENTITY_TABLES.map(tableFor), db.photos, db.settings],
    async () => {
      for (const name of ENTITY_TABLES) await tableFor(name).clear();
      await db.photos.clear();
      await db.settings.clear();
    },
  );
}
