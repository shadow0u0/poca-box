import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { repo } from './repo';
import { DEFAULT_QUALITY, type PhotoQuality } from './photos';
import type {
  Album,
  Card,
  CardSet,
  CardStatus,
  CardType,
  Folder,
  Group,
  ID,
  Member,
  Source,
} from './types';

export const PHOTO_QUALITY_KEY = 'photoQuality';
export const SYNC_ENABLED_KEY = 'syncEnabled';
/**
 * Watermark of the last successful pull. Lives here rather than in the sync
 * engine because startup needs to read it to decide whether to seed, and must
 * not drag the engine into the first-paint path to do so.
 */
export const SYNC_LAST_PULLED_KEY = 'syncLastPulledAt';
/**
 * The account this device last synced with.
 *
 * Local data outlives a sign-out by design, so without this a different account
 * signing in on the same browser would push the previous person's collection
 * into theirs — the watermarks having just been cleared, every local row looks
 * unsent. Comparing against this is what turns that into a question.
 */
export const SYNC_LAST_UID_KEY = 'syncLastUid';
/**
 * When a sync round last completed. Persisted rather than kept in memory so it
 * survives a reload: sync can fail quietly for days — an expired session, an
 * exhausted quota — and "last synced three days ago" is the one signal that
 * catches every cause without having to predict them.
 */
export const SYNC_LAST_OK_KEY = 'syncLastOkAt';

export interface Collections {
  groups: Group[];
  members: Member[];
  albums: Album[];
  sources: Source[];
  cardTypes: CardType[];
  statuses: CardStatus[];
  folders: Folder[];
  sets: CardSet[];
}

/**
 * Every classification list in one live query. They are small (tens of rows)
 * and nearly every screen needs several, so loading them together beats a
 * scatter of individual subscriptions.
 */
export function useCollections(): Collections | undefined {
  return useLiveQuery(async () => {
    const [groups, members, albums, sources, cardTypes, statuses, folders, sets] =
      await Promise.all([
        repo.groups.sorted(),
        repo.members.sorted(),
        repo.albums.sorted(),
        repo.sources.sorted(),
        repo.cardTypes.sorted(),
        repo.statuses.sorted(),
        repo.folders.sorted(),
        repo.cardSets.sorted(),
      ]);
    return { groups, members, albums, sources, cardTypes, statuses, folders, sets };
  }, []);
}

/** Compression settings chosen in 設定, falling back to the balanced preset. */
export function usePhotoQuality(): PhotoQuality {
  const stored = useLiveQuery(
    () => repo.settings.get<PhotoQuality>(PHOTO_QUALITY_KEY, DEFAULT_QUALITY),
    [],
  );
  return stored ?? DEFAULT_QUALITY;
}

/**
 * Whether the user has opted into cloud sync. Gates loading the Firebase SDK at
 * all, so someone who never turns sync on never pays for it.
 */
export function useSyncEnabled(): boolean | undefined {
  return useLiveQuery(() => repo.settings.get<boolean>(SYNC_ENABLED_KEY, false), []);
}

export function useCards(): Card[] | undefined {
  return useLiveQuery(() => repo.cards.list(), []);
}

export function useCard(id: ID | undefined): Card | undefined | null {
  return useLiveQuery(async () => (id ? ((await repo.cards.get(id)) ?? null) : null), [id]);
}

/** id → name lookups for rendering a card's fields without repeated `find`s. */
export function useNameLookup(collections: Collections | undefined) {
  return useMemo(() => {
    const toMap = <T extends { id: ID; name: string }>(rows: T[] | undefined) =>
      new Map((rows ?? []).map((r) => [r.id, r.name] as const));
    return {
      group: toMap(collections?.groups),
      member: toMap(collections?.members),
      album: toMap(collections?.albums),
      source: toMap(collections?.sources),
      cardType: toMap(collections?.cardTypes),
      status: toMap(collections?.statuses),
      folder: toMap(collections?.folders),
      set: toMap(collections?.sets),
    };
  }, [collections]);
}

export type NameLookup = ReturnType<typeof useNameLookup>;
