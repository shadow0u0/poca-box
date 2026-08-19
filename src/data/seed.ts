import { db } from './db';
import { repo } from './repo';
import { builtinId, nameKey } from '../lib/id';
import type { Taxonomy } from './types';

/**
 * Starter classifications so the app is usable on first launch. They are
 * ordinary rows: rename, reorder or delete any of them freely.
 *
 * Seeding is *additive and remembered*. Every default name that has ever been
 * offered is recorded in `settings`, and only names absent from that record get
 * created. That gives two properties an install needs to survive updates:
 *
 *   - a default the user deleted stays deleted, instead of reappearing;
 *   - a default added by a later release does reach existing installs, instead
 *     of only ever showing up for brand-new ones.
 */
const DEFAULT_SOURCES = [
  '專輯特典',
  '快閃店 POP-UP',
  '演唱會周邊',
  '抽卡機',
  '代購／代拍',
  '二手交換',
  '網拍／蝦皮',
  '朋友贈送',
];

const DEFAULT_CARD_TYPES = [
  '官方小卡',
  '福卡',
  '簽名卡',
  '小卡冊限定',
  '應援會限定',
  '拍立得',
  '自製卡',
];

const DEFAULT_STATUSES = ['持有中', '待交換', '願望清單', '已出讓'];

/**
 * The creation time stamped on every seeded default, on every device.
 *
 * Deliberately far in the past and identical everywhere: it makes seeding lose
 * every merge it could take part in, so a default cannot come back to life or
 * revert a rename just because another device booted for the first time.
 */
const SEEDED_AT = '2000-01-01T00:00:00.000Z';

/** Legacy marker from the first release: a plain version number. */
const SEED_KEY = 'seededVersion';
/** Names already offered, per table, so deletions are not undone. */
const OFFERED_KEY = 'seededDefaultNames';

type SeedTable = 'sources' | 'cardTypes' | 'statuses';

const DEFAULTS: Record<SeedTable, string[]> = {
  sources: DEFAULT_SOURCES,
  cardTypes: DEFAULT_CARD_TYPES,
  statuses: DEFAULT_STATUSES,
};

type OfferedRecord = Partial<Record<SeedTable, string[]>>;

/**
 * Add any starter classifications this install has not been offered yet.
 *
 * Returns how many rows it created. Callers need that because a seeded row
 * carries `SEEDED_AT`, which is older than any push watermark — so a default
 * introduced by a later release is invisible to the ordinary "send everything
 * newer than last time" push and would never reach the cloud on its own.
 */
export async function seedIfNeeded(): Promise<number> {
  const offered = await repo.settings.get<OfferedRecord>(OFFERED_KEY, {});
  const legacySeeded = (await repo.settings.get<number>(SEED_KEY, 0)) > 0;
  let created = 0;

  await db.transaction('rw', db.sources, db.cardTypes, db.statuses, db.settings, async () => {
    const nextOffered: OfferedRecord = { ...offered };

    for (const table of Object.keys(DEFAULTS) as SeedTable[]) {
      const names = DEFAULTS[table];
      const store = db[table];

      let alreadyOffered = offered[table];
      if (!alreadyOffered) {
        // First run under the new scheme. An install seeded by the original
        // release already has these rows, so treat them as offered rather than
        // trying to add them again.
        alreadyOffered = legacySeeded || (await store.count()) > 0 ? [...names] : [];
      }
      const offeredKeys = new Set(alreadyOffered.map(nameKey));

      // Skip anything the user already has under that name, whatever its origin.
      const existingKeys = new Set((await store.toArray()).map((row) => nameKey(row.name)));

      const missing = names.filter((n) => !offeredKeys.has(nameKey(n)) && !existingKeys.has(nameKey(n)));

      if (missing.length > 0) {
        const highest = (await store.toArray()).reduce(
          (max, row) => Math.max(max, row.sortOrder),
          -1,
        );
        const rows: Taxonomy[] = missing.map((name, index) => ({
          // Derived from the name, so two devices seeding the same default
          // produce the same row rather than two that sync cannot tell apart.
          id: builtinId(table, name),
          name,
          sortOrder: highest + 1 + index,
          isBuiltIn: 1,
          // A fixed timestamp, not `now`. Seeding on a second device must never
          // win a merge against the copy already in the cloud — otherwise a
          // rename made on one device would be undone by another device's first
          // launch. Any real edit carries a present-day timestamp and wins.
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
          isDeleted: 0,
        }));
        await store.bulkPut(rows);
        created += rows.length;
      }

      nextOffered[table] = [...new Set([...alreadyOffered, ...names])];
    }

    await db.settings.put({ key: OFFERED_KEY, value: nextOffered });
  });

  return created;
}

/**
 * Ask the browser to exempt this origin from storage eviction.
 *
 * iOS Safari can clear IndexedDB for sites that are not installed to the home
 * screen and go unused for a while, which would take the whole collection with
 * it. Installing plus this grant makes that far less likely — but the zip
 * backup in 設定 remains the real safety net, and the UI says so.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
