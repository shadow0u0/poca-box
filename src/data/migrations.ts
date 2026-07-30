import { ENTITY_TABLES, type EntityTableName } from './db';
import type { BaseEntity, Card } from './types';

/**
 * Data-content migrations.
 *
 * Dexie's `version().stores()` only migrates *indexes and object stores*. It
 * does nothing about the shape of the rows themselves, so renaming a field or
 * changing how a value is encoded needs its own upgrade path — that is what
 * lives here.
 *
 * The rules that keep updates seamless:
 *
 *  1. Bump `DATA_VERSION` and append exactly one step to `MIGRATIONS` whenever a
 *     release changes the meaning or shape of stored data. Never edit an
 *     existing step — someone is still on the version before it.
 *  2. Steps are pure functions over plain objects (no Dexie, no Blobs), so they
 *     run identically against live data and against an imported backup, and can
 *     be unit-tested without a browser.
 *  3. Steps must be idempotent and defensive: they may see rows written by any
 *     older release, including ones with fields missing entirely.
 *
 * Photo blobs are deliberately out of scope. Metadata changes never rewrite
 * image bytes, so migrations only ever touch the (small) entity tables.
 */

// Annotated as `number`, not left to infer the literal `1`: comparisons against
// it elsewhere must keep compiling when a future release bumps this.
export const DATA_VERSION: number = 1;

export const DATA_VERSION_KEY = 'dataVersion';
export const PRE_MIGRATION_SNAPSHOT_KEY = 'preMigrationSnapshot';

/** The entity tables as plain arrays — the payload every migration operates on. */
export type MigratableTables = Record<EntityTableName, BaseEntity[]>;

export interface MigrationStep {
  /** The version this step produces. */
  to: number;
  /** Shown in the console and in the migration report. */
  describe: string;
  migrate(tables: MigratableTables): MigratableTables;
}

/**
 * Ordered upgrade steps. v1 is the initial format, so there is nothing to do
 * yet — a future release that reshapes data appends `{ to: 2, ... }` here and
 * bumps DATA_VERSION to 2.
 */
export const MIGRATIONS: MigrationStep[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Force a row to satisfy the invariants the UI relies on.
 *
 * Applied to everything coming from outside the running app — imported backups,
 * and rows written by older releases. A card whose `memberIds` is missing would
 * otherwise crash the first `.includes()` call that touched it, so the defensive
 * pass matters more than it looks.
 */
export function normalizeEntity(table: EntityTableName, input: unknown): BaseEntity | null {
  if (!isRecord(input)) return null;
  const id = input.id;
  if (typeof id !== 'string' || id.length === 0) return null;

  const now = new Date().toISOString();
  const base: BaseEntity = {
    id,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
    // Anything other than exactly 1 counts as "not deleted", so a corrupt flag
    // hides a card rather than silently destroying it.
    isDeleted: input.isDeleted === 1 ? 1 : 0,
  };
  if (typeof input.deletedAt === 'string') base.deletedAt = input.deletedAt;

  if (table !== 'cards') {
    // Named rows (groups, members, albums, folders, sets, taxonomies) all need a
    // usable name and sortOrder; everything else passes through untouched.
    const name = typeof input.name === 'string' ? input.name : '';
    if (!name.trim()) return null;
    return {
      ...input,
      ...base,
      name,
      sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : 0,
    } as BaseEntity;
  }

  const acquiredAt =
    typeof input.acquiredAt === 'string' && ISO_DATE.test(input.acquiredAt)
      ? input.acquiredAt
      : base.createdAt.slice(0, 10);

  const card: Card = {
    ...(input as object),
    ...base,
    name: typeof input.name === 'string' && input.name.trim() ? input.name : '（未命名）',
    acquiredAt,
    memberIds: asStringArray(input.memberIds),
    folderIds: asStringArray(input.folderIds),
    price: typeof input.price === 'number' && Number.isFinite(input.price) ? input.price : undefined,
  } as Card;

  // A slot reference is only meaningful with both halves present.
  if (!card.setId || !card.setSlotId) {
    card.setId = undefined;
    card.setSlotId = undefined;
  }

  return card as BaseEntity;
}

export function normalizeTables(tables: Partial<MigratableTables>): MigratableTables {
  const out = {} as MigratableTables;
  for (const table of ENTITY_TABLES) {
    const rows = tables[table] ?? [];
    out[table] = (Array.isArray(rows) ? rows : [])
      .map((row) => normalizeEntity(table, row))
      .filter((row): row is BaseEntity => row !== null);
  }
  return out;
}

export interface MigrationOutcome {
  from: number;
  to: number;
  applied: string[];
  tables: MigratableTables;
}

/**
 * Bring a metadata payload up to `DATA_VERSION`, applying every step in order.
 *
 * A payload from a *newer* release is returned untouched: this app cannot know
 * how to downgrade it, and rewriting it would lose whatever the newer fields
 * meant. Callers that must reject rather than tolerate that case check the
 * version themselves (see `importBackup`).
 */
export function migrateTables(
  tables: Partial<MigratableTables>,
  fromVersion: number,
): MigrationOutcome {
  let current = normalizeTables(tables);
  const applied: string[] = [];
  let version = Number.isFinite(fromVersion) && fromVersion > 0 ? fromVersion : 1;

  for (const step of MIGRATIONS) {
    if (step.to <= version) continue;
    current = normalizeTables(step.migrate(current));
    applied.push(`v${version} → v${step.to}: ${step.describe}`);
    version = step.to;
  }

  return { from: fromVersion, to: version, applied, tables: current };
}

/** True when a payload is newer than this build knows how to read. */
export function isFromFuture(version: number): boolean {
  return version > DATA_VERSION;
}
