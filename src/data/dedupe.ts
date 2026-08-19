import { db } from './db';
import { nameKey, nowIso } from '../lib/id';
import type { Card, ID, Taxonomy } from './types';

/**
 * Collapse classifications that share a name.
 *
 * Devices used to seed the starter 來源／卡種／持有狀態 with random ids, so each
 * one produced its own "官方小卡" and sync — which matches rows by id — kept
 * every copy. `builtinId` stops new ones appearing; this repairs what already
 * exists, on this device and, through the tombstones it writes, in the cloud.
 *
 * It runs after every pull rather than once as a migration, because a one-off
 * cannot cover the two cases that remain: the cloud still holds several id sets
 * today, and a brand-new device always seeds before its first pull. Treating it
 * as an invariant to re-establish, rather than a one-time repair, means the
 * library converges no matter what order devices arrive in.
 *
 * Merging by name is safe here specifically because these three tables already
 * treat the name as the identity — `repo.sources.ensure(name)` reuses a row of
 * the same name rather than making a second one. That is not true of groups,
 * albums or folders, where two things really can share a name, so those are
 * left alone.
 */

/** Tables to collapse, and the card field that points at each. */
const TARGETS = [
  { table: 'sources', field: 'sourceId' },
  { table: 'cardTypes', field: 'cardTypeId' },
  { table: 'statuses', field: 'statusId' },
] as const;

export interface DedupeResult {
  /** Rows tombstoned because a row of the same name won. */
  merged: number;
  /** Cards repointed from a loser to the winner. */
  repointed: number;
}

/**
 * Pick the row that survives among same-named rows.
 *
 * The smallest id wins, and nothing else is consulted. Devices see different
 * subsets while a sync is in progress, so the rule has to give the same answer
 * from partial information: a device that has not yet pulled the true winner
 * picks a temporary one, and the eventual winner can only be smaller, so the
 * choice moves in one direction and settles. Choosing by `createdAt` instead
 * would let two devices each delete the other's keeper.
 */
function winnerOf(rows: Taxonomy[]): Taxonomy {
  return rows.reduce((best, row) => (row.id < best.id ? row : best));
}

export async function dedupeTaxonomies(): Promise<DedupeResult> {
  const result: DedupeResult = { merged: 0, repointed: 0 };

  for (const { table, field } of TARGETS) {
    const rows = (await db[table].toArray()).filter((row) => row.isDeleted === 0);

    const byName = new Map<string, Taxonomy[]>();
    for (const row of rows) {
      const key = nameKey(row.name);
      const group = byName.get(key);
      if (group) group.push(row);
      else byName.set(key, [row]);
    }

    // loser id -> winner id
    const replacement = new Map<ID, ID>();
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      const winner = winnerOf(group);
      for (const row of group) {
        if (row.id !== winner.id) replacement.set(row.id, winner.id);
      }
    }
    if (replacement.size === 0) continue;

    await db.transaction('rw', db[table], db.cards, async () => {
      const at = nowIso();

      // Soft delete, never a hard one: the tombstone is what removes the
      // duplicate from the other devices and from the cloud. A plain delete
      // here would simply be re-downloaded on the next pull.
      for (const id of replacement.keys()) {
        await db[table].update(id, { isDeleted: 1, deletedAt: at, updatedAt: at });
      }
      result.merged += replacement.size;

      // Repoint before the tombstones can reach anyone: a card left pointing at
      // a deleted classification would show a blank field.
      const cards = await db.cards.toArray();
      for (const card of cards) {
        const current = card[field as keyof Card] as ID | undefined;
        if (!current) continue;
        const winner = replacement.get(current);
        if (!winner) continue;
        await db.cards.update(card.id, { [field]: winner, updatedAt: at });
        result.repointed += 1;
      }
    });
  }

  return result;
}
