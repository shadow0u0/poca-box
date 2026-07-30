import { db } from './db';
import { repo } from './repo';

/**
 * Starter classifications so the app is usable on first launch. They are
 * ordinary rows: rename, reorder or delete any of them freely. `isBuiltIn`
 * exists only so this function can tell whether it has already run.
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

const SEED_KEY = 'seededVersion';
const SEED_VERSION = 1;

export async function seedIfNeeded(): Promise<void> {
  const seeded = await repo.settings.get<number>(SEED_KEY, 0);
  if (seeded >= SEED_VERSION) return;

  await db.transaction('rw', db.sources, db.cardTypes, db.statuses, db.settings, async () => {
    const now = new Date().toISOString();
    const rows = (names: string[]) =>
      names.map((name, index) => ({
        id: crypto.randomUUID(),
        name,
        sortOrder: index,
        isBuiltIn: 1 as const,
        createdAt: now,
        updatedAt: now,
        isDeleted: 0 as const,
      }));

    // `bulkAdd` rather than `bulkPut`: if a user already made their own list,
    // an interrupted first run must not resurrect the defaults on top of it.
    if ((await db.sources.count()) === 0) await db.sources.bulkAdd(rows(DEFAULT_SOURCES));
    if ((await db.cardTypes.count()) === 0) await db.cardTypes.bulkAdd(rows(DEFAULT_CARD_TYPES));
    if ((await db.statuses.count()) === 0) await db.statuses.bulkAdd(rows(DEFAULT_STATUSES));

    await db.settings.put({ key: SEED_KEY, value: SEED_VERSION });
  });
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
