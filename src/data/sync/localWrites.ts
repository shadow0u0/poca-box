import { db, ENTITY_TABLES } from '../db';

/**
 * Tells the sync engine that this device just changed something.
 *
 * Waiting for the next 60 second tick is fine for a device that is catching up,
 * and far too slow for the person who just renamed a card and walked over to
 * their phone — they have no way to tell "not synced yet" from "broken". This
 * closes that gap without polling.
 *
 * The hard part is not noticing writes; it is ignoring the ones sync makes
 * itself, which `suppressLocalWrites` marks. This is not protection against an
 * endless loop — `pull` skips rows that are not newer, so a follow-up round
 * writes nothing and stops on its own, and removing the suppression measurably
 * changes nothing there. It earns its place elsewhere: filling in downloaded
 * photos writes a row per image while deliberately leaving `updatedAt` alone,
 * and without this every one of them would queue a sync that has nothing to
 * send. A genuine edit made *during* a round is remembered rather than dropped,
 * and scheduled once the round is over.
 */

let suppression = 0;
let missedWhileSuppressed = false;
const listeners = new Set<() => void>();

/**
 * Run `fn` without its writes counting as local edits.
 *
 * Counted rather than boolean: photo sync nests inside a sync round, and a
 * plain flag would be cleared by the inner call while the outer one was still
 * applying remote data.
 */
export async function suppressLocalWrites<T>(fn: () => Promise<T>): Promise<T> {
  suppression += 1;
  try {
    return await fn();
  } finally {
    suppression -= 1;
    if (suppression === 0 && missedWhileSuppressed) {
      missedWhileSuppressed = false;
      // An edit landed while sync was applying remote rows. It is genuinely
      // local and still needs pushing, so let it through now.
      for (const listener of listeners) listener();
    }
  }
}

function notify(): void {
  if (suppression > 0) {
    missedWhileSuppressed = true;
    return;
  }
  for (const listener of listeners) listener();
}

/** Every table whose rows are worth pushing. */
const WATCHED = [...ENTITY_TABLES, 'photos'] as const;

/**
 * Call `onWrite` whenever this device changes a row of its own.
 *
 * Dexie fires these inside the writing transaction, so the callback must be
 * cheap — it only schedules.
 */
export function watchLocalWrites(onWrite: () => void): () => void {
  listeners.add(onWrite);

  const detach = WATCHED.map((name) => {
    const table = db.table(name);
    const hit = () => notify();
    table.hook('creating', hit);
    table.hook('updating', hit);
    table.hook('deleting', hit);
    return () => {
      table.hook('creating').unsubscribe(hit);
      table.hook('updating').unsubscribe(hit);
      table.hook('deleting').unsubscribe(hit);
    };
  });

  return () => {
    listeners.delete(onWrite);
    for (const off of detach) off();
  };
}
