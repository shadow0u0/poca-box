import type { Table } from 'dexie';
import { db } from './db';
import { nameKey, newId, nowIso } from '../lib/id';
import type {
  Album,
  BaseEntity,
  Card,
  CardSet,
  CardStatus,
  CardType,
  Folder,
  Group,
  ID,
  Member,
  SetSlot,
  Source,
} from './types';

/**
 * The single door to stored data — UI never touches Dexie directly.
 *
 * Everything below writes `updatedAt` on every mutation and deletes softly, so
 * bolting on cloud sync later means adding a remote adapter behind this module
 * rather than rewriting the screens.
 */

/** Fields the caller supplies; timestamps and flags are filled in here. */
export type NewEntity<T extends BaseEntity> = Omit<T, keyof BaseEntity> &
  Partial<Pick<BaseEntity, 'id'>>;

function stamp<T extends BaseEntity>(input: NewEntity<T>): T {
  const now = nowIso();
  return {
    ...(input as object),
    id: input.id ?? newId(),
    createdAt: now,
    updatedAt: now,
    isDeleted: 0,
  } as T;
}

interface Crud<T extends BaseEntity> {
  table: Table<T, ID>;
  all(): Promise<T[]>;
  get(id: ID | undefined): Promise<T | undefined>;
  create(input: NewEntity<T>): Promise<T>;
  update(id: ID, patch: Partial<T>): Promise<void>;
  /** Soft delete — the row stays so the deletion can sync and be undone. */
  remove(id: ID): Promise<void>;
  restore(id: ID): Promise<void>;
  /** Permanent removal. Used by backup restore, not by the UI. */
  purge(id: ID): Promise<void>;
}

function crud<T extends BaseEntity>(table: Table<T, ID>): Crud<T> {
  return {
    table,
    async all() {
      return table.where('isDeleted').equals(0).toArray();
    },
    async get(id) {
      if (!id) return undefined;
      const row = await table.get(id);
      return row && row.isDeleted === 0 ? row : undefined;
    },
    async create(input) {
      const row = stamp<T>(input);
      await table.add(row);
      return row;
    },
    async update(id, patch) {
      await table.update(id, { ...patch, updatedAt: nowIso() } as never);
    },
    async remove(id) {
      const now = nowIso();
      await table.update(id, { isDeleted: 1, deletedAt: now, updatedAt: now } as never);
    },
    async restore(id) {
      await table.update(id, {
        isDeleted: 0,
        deletedAt: undefined,
        updatedAt: nowIso(),
      } as never);
    },
    async purge(id) {
      await table.delete(id);
    },
  };
}

/** Sort by explicit order first, then by name — used by every picker list. */
function bySortOrder<T extends { sortOrder: number; name: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-Hant'),
  );
}

interface Named extends BaseEntity {
  name: string;
  sortOrder: number;
}

/**
 * Adds the "type a name that doesn't exist yet and create it inline" behaviour
 * the card form relies on, plus duplicate-safe naming.
 */
function namedCrud<T extends Named>(table: Table<T, ID>, extraDefaults: () => Partial<T> = () => ({})) {
  const base = crud<T>(table);
  return {
    ...base,
    async sorted(): Promise<T[]> {
      return bySortOrder(await base.all());
    },
    async nextSortOrder(): Promise<number> {
      const rows = await base.all();
      return rows.reduce((max, r) => Math.max(max, r.sortOrder), -1) + 1;
    },
    async findByName(name: string): Promise<T | undefined> {
      const key = nameKey(name);
      return (await base.all()).find((r) => nameKey(r.name) === key);
    },
    /** Returns the existing row with this name, or creates one. */
    async ensure(name: string, extra: Partial<T> = {}): Promise<T> {
      const trimmed = name.trim();
      const existing = await this.findByName(trimmed);
      if (existing) return existing;
      return base.create({
        name: trimmed,
        sortOrder: await this.nextSortOrder(),
        ...extraDefaults(),
        ...extra,
      } as unknown as NewEntity<T>);
    },
    async rename(id: ID, name: string): Promise<void> {
      await base.update(id, { name: name.trim() } as Partial<T>);
    },
    /** Persist a drag-reordered list in one transaction. */
    async reorder(orderedIds: ID[]): Promise<void> {
      const now = nowIso();
      await db.transaction('rw', table, async () => {
        await Promise.all(
          orderedIds.map((id, index) =>
            table.update(id, { sortOrder: index, updatedAt: now } as never),
          ),
        );
      });
    },
  };
}

const groups = namedCrud<Group>(db.groups);
const albums = namedCrud<Album>(db.albums);

const members = {
  ...namedCrud<Member>(db.members),

  async inGroup(groupId: ID): Promise<Member[]> {
    const rows = await db.members.where('groupId').equals(groupId).toArray();
    return bySortOrder(rows.filter((m) => m.isDeleted === 0));
  },

  /**
   * Member names only need to be unique inside their own group — two groups may
   * each have a 智慧 — so this scopes the duplicate check rather than using the
   * global `ensure`.
   */
  async ensureInGroup(groupId: ID, name: string): Promise<Member> {
    const trimmed = name.trim();
    const key = nameKey(trimmed);
    const existing = (await this.inGroup(groupId)).find((m) => nameKey(m.name) === key);
    if (existing) return existing;
    const siblings = await this.inGroup(groupId);
    return crud<Member>(db.members).create({
      groupId,
      name: trimmed,
      sortOrder: siblings.reduce((max, m) => Math.max(max, m.sortOrder), -1) + 1,
    });
  },
};
const sources = namedCrud<Source>(db.sources, () => ({ isBuiltIn: 0 }) as Partial<Source>);
const cardTypes = namedCrud<CardType>(db.cardTypes, () => ({ isBuiltIn: 0 }) as Partial<CardType>);
const statuses = namedCrud<CardStatus>(db.statuses, () => ({ isBuiltIn: 0 }) as Partial<CardStatus>);
const folders = namedCrud<Folder>(db.folders);
const cardSets = namedCrud<CardSet>(db.cardSets);

/** Card fields that point at a user-editable classification row. */
export type CardRefField =
  | 'groupId'
  | 'albumId'
  | 'sourceId'
  | 'cardTypeId'
  | 'statusId'
  | 'setId';

const cards = {
  ...crud<Card>(db.cards),

  /**
   * Every live card. The wall filters and sorts these in memory: card rows hold
   * no Blobs, so even a few thousand of them cost little, and it keeps
   * arbitrary multi-dimension filtering correct without index gymnastics.
   */
  async list(): Promise<Card[]> {
    const rows = await db.cards.where('isDeleted').equals(0).toArray();
    return rows.sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt) || b.createdAt.localeCompare(a.createdAt));
  },

  async byMember(memberId: ID): Promise<Card[]> {
    const rows = await db.cards.where('memberIds').equals(memberId).toArray();
    return rows.filter((c) => c.isDeleted === 0);
  },

  async byFolder(folderId: ID): Promise<Card[]> {
    const rows = await db.cards.where('folderIds').equals(folderId).toArray();
    return rows.filter((c) => c.isDeleted === 0);
  },

  async bySet(setId: ID): Promise<Card[]> {
    const rows = await db.cards.where('setId').equals(setId).toArray();
    return rows.filter((c) => c.isDeleted === 0);
  },

  /** How many live cards still point at a classification row. */
  async countUsing(field: CardRefField, id: ID): Promise<number> {
    const rows = await db.cards.where(field).equals(id).toArray();
    return rows.filter((c) => c.isDeleted === 0).length;
  },

  async countUsingMember(memberId: ID): Promise<number> {
    return (await this.byMember(memberId)).length;
  },

  /** Point every card using `from` at `to` (or clear the field when undefined). */
  async reassign(field: CardRefField, from: ID, to: ID | undefined): Promise<void> {
    const affected = await db.cards.where(field).equals(from).toArray();
    const now = nowIso();
    await db.transaction('rw', db.cards, async () => {
      await Promise.all(
        affected.map((card) =>
          db.cards.update(card.id, { [field]: to, updatedAt: now } as never),
        ),
      );
    });
  },

  async removeMemberEverywhere(memberId: ID): Promise<void> {
    const affected = await db.cards.where('memberIds').equals(memberId).toArray();
    const now = nowIso();
    await db.transaction('rw', db.cards, async () => {
      await Promise.all(
        affected.map((card) =>
          db.cards.update(card.id, {
            memberIds: card.memberIds.filter((m) => m !== memberId),
            updatedAt: now,
          } as never),
        ),
      );
    });
  },

  async removeFolderEverywhere(folderId: ID): Promise<void> {
    const affected = await db.cards.where('folderIds').equals(folderId).toArray();
    const now = nowIso();
    await db.transaction('rw', db.cards, async () => {
      await Promise.all(
        affected.map((card) =>
          db.cards.update(card.id, {
            folderIds: card.folderIds.filter((f) => f !== folderId),
            updatedAt: now,
          } as never),
        ),
      );
    });
  },

  async setFolders(cardIds: ID[], folderId: ID, add: boolean): Promise<void> {
    const now = nowIso();
    await db.transaction('rw', db.cards, async () => {
      for (const id of cardIds) {
        const card = await db.cards.get(id);
        if (!card) continue;
        const has = card.folderIds.includes(folderId);
        if (has === add) continue;
        const folderIds = add
          ? [...card.folderIds, folderId]
          : card.folderIds.filter((f) => f !== folderId);
        await db.cards.update(id, { folderIds, updatedAt: now } as never);
      }
    });
  },

  /** Attach a card to one slot of a 套卡, releasing whatever held it before. */
  async assignToSlot(cardId: ID, setId: ID, slotId: ID): Promise<void> {
    const now = nowIso();
    await db.transaction('rw', db.cards, async () => {
      const previous = (await db.cards.where('setId').equals(setId).toArray()).filter(
        (c) => c.isDeleted === 0 && c.setSlotId === slotId && c.id !== cardId,
      );
      await Promise.all(
        previous.map((c) =>
          db.cards.update(c.id, { setId: undefined, setSlotId: undefined, updatedAt: now } as never),
        ),
      );
      await db.cards.update(cardId, { setId, setSlotId: slotId, updatedAt: now } as never);
    });
  },

  async clearSlot(cardId: ID): Promise<void> {
    await db.cards.update(cardId, {
      setId: undefined,
      setSlotId: undefined,
      updatedAt: nowIso(),
    } as never);
  },
};

const photos = {
  ...crud(db.photos),
  /**
   * Delete a photo only when no live card still shows it — two cards can point
   * at the same photo after a duplicate, and dropping it would break both.
   */
  async removeIfOrphaned(photoId: ID | undefined): Promise<void> {
    if (!photoId) return;
    const [asFront, asBack] = await Promise.all([
      db.cards.where('frontPhotoId').equals(photoId).toArray(),
      db.cards.where('backPhotoId').equals(photoId).toArray(),
    ]);
    const stillUsed = [...asFront, ...asBack].some((c) => c.isDeleted === 0);
    if (!stillUsed) await db.photos.delete(photoId);
  },
};

/** Build one slot per member, in the group's own member order. */
export function slotsForMembers(memberRows: Member[]): SetSlot[] {
  return bySortOrder(memberRows).map((m) => ({
    id: newId(),
    memberId: m.id,
    label: m.name,
  }));
}

const settings = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await db.settings.get(key);
    return row ? (row.value as T) : fallback;
  },
  async set(key: string, value: unknown): Promise<void> {
    await db.settings.put({ key, value });
  },
};

export const repo = {
  cards,
  photos,
  groups,
  members,
  albums,
  sources,
  cardTypes,
  statuses,
  folders,
  cardSets,
  settings,
};

export type Repo = typeof repo;
