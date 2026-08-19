export type ID = string;

/** IndexedDB cannot index `undefined`/`null`, so soft-delete uses a 0/1 flag. */
export type Flag = 0 | 1;

/**
 * Every stored row carries these. `updatedAt` + `deletedAt` are what a future
 * cloud sync needs to merge two devices (last-write-wins) and to propagate
 * deletions — keeping them from day one means the schema won't have to change.
 */
export interface BaseEntity {
  id: ID;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  isDeleted: Flag;
  deletedAt?: string;
}

export interface Card extends BaseEntity {
  name: string;
  note?: string;
  /** 收藏時間 — the day it joined the collection, as YYYY-MM-DD. */
  acquiredAt: string;
  groupId?: ID;
  /** Several members for unit cards and group shots. */
  memberIds: ID[];
  /** 專輯／活動出處 */
  albumId?: ID;
  sourceId?: ID;
  cardTypeId?: ID;
  statusId?: ID;
  price?: number;
  currency?: string;
  frontPhotoId?: ID;
  backPhotoId?: ID;
  /** A card may sit in several 收藏夾 at once. */
  folderIds: ID[];
  /** Set to the slot this card fills, when it belongs to a 套卡. */
  setId?: ID;
  setSlotId?: ID;
}

/**
 * Photos live in their own table so listing a thousand cards never pulls a
 * thousand Blobs into memory — the card row only holds an id.
 */
export interface Photo extends BaseEntity {
  blob: Blob;
  thumbBlob: Blob;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /**
   * Set while `blob` still holds the thumbnail standing in for a full image
   * that cloud sync has not finished downloading. Absent — not `0` — once the
   * real image lands, because IndexedDB indexes only rows where the field
   * exists, which is what makes "what still needs downloading" a cheap lookup.
   */
  pendingFull?: 1;
}

export interface Group extends BaseEntity {
  name: string;
  color?: string;
  sortOrder: number;
}

export interface Member extends BaseEntity {
  groupId: ID;
  name: string;
  sortOrder: number;
}

/** 專輯／活動出處 — an album, a concert, a pop-up, a fan meeting. */
export interface Album extends BaseEntity {
  name: string;
  groupId?: ID;
  releaseDate?: string;
  sortOrder: number;
}

/**
 * A folder has no cover of its own: `FoldersPage` shows the first photo among
 * the cards it contains, the same rule groups and members use. A stored
 * `coverPhotoId` field existed here for a while and was never once assigned,
 * which only made the cloud cleanup look like it had a case to handle.
 */
export interface Folder extends BaseEntity {
  name: string;
  sortOrder: number;
}

/**
 * 來源 / 卡種 / 持有狀態 share one shape, so they share one editor UI.
 * `isBuiltIn` only marks rows that seeding created — they stay fully editable
 * and deletable, it exists so re-seeding doesn't duplicate them.
 */
export interface Taxonomy extends BaseEntity {
  name: string;
  sortOrder: number;
  isBuiltIn: Flag;
}

export type Source = Taxonomy;
export type CardType = Taxonomy;
export type CardStatus = Taxonomy;

export interface SetSlot {
  id: ID;
  /** Usually one slot per member; left empty for extra slots like unit cards. */
  memberId?: ID;
  label: string;
}

/** 團體全員套卡 — completion is computed from cards, never stored. */
export interface CardSet extends BaseEntity {
  name: string;
  groupId?: ID;
  albumId?: ID;
  slots: SetSlot[];
  sortOrder: number;
}

export interface AppSetting {
  key: string;
  value: unknown;
}

/** Names of the tables holding user-editable classifications. */
export type TaxonomyTable = 'sources' | 'cardTypes' | 'statuses';
