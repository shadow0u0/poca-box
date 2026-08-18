import Dexie, { type Table } from 'dexie';
import type {
  Album,
  AppSetting,
  Card,
  CardSet,
  CardStatus,
  CardType,
  Folder,
  Group,
  ID,
  Member,
  Photo,
  Source,
} from './types';

export class PocaBoxDB extends Dexie {
  cards!: Table<Card, ID>;
  photos!: Table<Photo, ID>;
  groups!: Table<Group, ID>;
  members!: Table<Member, ID>;
  albums!: Table<Album, ID>;
  sources!: Table<Source, ID>;
  cardTypes!: Table<CardType, ID>;
  statuses!: Table<CardStatus, ID>;
  folders!: Table<Folder, ID>;
  cardSets!: Table<CardSet, ID>;
  settings!: Table<AppSetting, string>;

  constructor() {
    super('poca-box');

    // The card wall filters on many dimensions at once, which no single index
    // can serve. Those queries load the (small, Blob-free) card rows and filter
    // in memory instead. The indexes below back the targeted lookups —
    // one member's cards, one folder's cards, referential-integrity checks
    // before deleting a classification — and future sync's updatedAt scans.
    this.version(1).stores({
      cards:
        'id, isDeleted, updatedAt, acquiredAt, groupId, albumId, sourceId, cardTypeId, statusId, setId, frontPhotoId, backPhotoId, *memberIds, *folderIds',
      photos: 'id, isDeleted, updatedAt',
      groups: 'id, isDeleted, updatedAt, name, sortOrder',
      members: 'id, isDeleted, updatedAt, groupId, name, sortOrder',
      albums: 'id, isDeleted, updatedAt, groupId, name, sortOrder',
      sources: 'id, isDeleted, updatedAt, name, sortOrder',
      cardTypes: 'id, isDeleted, updatedAt, name, sortOrder',
      statuses: 'id, isDeleted, updatedAt, name, sortOrder',
      folders: 'id, isDeleted, updatedAt, name, sortOrder',
      cardSets: 'id, isDeleted, updatedAt, groupId, name, sortOrder',
      settings: 'key',
    });

    // Adds one index, on the marker cloud sync sets while a photo is still
    // showing its thumbnail in place of the full image. Dexie re-indexes the
    // existing rows by itself; nothing else about the table changes, and
    // version(1) above stays exactly as it shipped.
    //
    // The point of indexing it is that `.primaryKeys()` on this index reads ids
    // straight out of the index — scanning the table instead would pull every
    // photo's Blob into memory just to find the handful still waiting.
    this.version(2).stores({
      photos: 'id, isDeleted, updatedAt, pendingFull',
    });
  }
}

export const db = new PocaBoxDB();

/** Every table that holds syncable entities, in dependency-friendly order. */
export const ENTITY_TABLES = [
  'groups',
  'members',
  'albums',
  'sources',
  'cardTypes',
  'statuses',
  'folders',
  'cardSets',
  'cards',
] as const;

export type EntityTableName = (typeof ENTITY_TABLES)[number];
