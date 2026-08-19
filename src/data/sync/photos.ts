import type { Firestore } from 'firebase/firestore';
import { db } from '../db';
import { invalidatePhotoUrl } from '../photos';
import type { ID, Photo } from '../types';
import { getIdToken } from './auth';
import { suppressLocalWrites } from './localWrites';

/**
 * Photo sync: metadata through Firestore, pixels through our own Cloudflare
 * Worker in front of R2 (`worker/src/index.ts`).
 *
 * Photos are immutable — replacing a card's picture creates a new id — so
 * unlike the metadata in `engine.ts` there is never a conflict to resolve, only
 * a question of which side is missing a file.
 *
 * They deliberately do **not** ride along in `ENTITY_TABLES`. That path ends in
 * `table.put(remoteRow)`, and a row coming back from Firestore has no Blobs, so
 * a single pull would wipe every image on the device. Photos therefore keep
 * their own push/pull here, reusing the same watermark and last-write-wins
 * rules but never letting a remote row overwrite local binary data.
 *
 * The download order is thumbnails for everything first, full images afterwards
 * in the background: a new device shows a complete, browsable collection in the
 * time it takes to fetch ~15 KB per card rather than ~200 KB.
 */

/** Public URL of the deployed Worker — an address, not a secret. */
const DEFAULT_ENDPOINT = 'https://poca-box-photos.eason-fe.workers.dev';

const LAST_PUSHED_KEY = 'syncPhotosLastPushedAt';
const LAST_PULLED_KEY = 'syncPhotosLastPulledAt';

/** Rows are loaded a chunk at a time so a first sync never holds every Blob at once. */
const CHUNK = 20;
/** Simultaneous transfers. Enough to hide latency, few enough to stay polite. */
const PARALLEL = 3;

export type PhotoSyncState =
  | { state: 'idle'; pendingFull?: number }
  | { state: 'uploading'; done: number; total: number }
  | { state: 'downloading'; done: number; total: number }
  | { state: 'filling'; done: number; total: number }
  | { state: 'error'; message: string };

type Listener = (state: PhotoSyncState) => void;

let state: PhotoSyncState = { state: 'idle' };
const listeners = new Set<Listener>();

function setState(next: PhotoSyncState) {
  state = next;
  for (const l of listeners) l(next);
}

export function getPhotoSyncState(): PhotoSyncState {
  return state;
}

export function onPhotoSyncState(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/** What lives in Firestore: the photo row with both Blobs and local-only flags removed. */
type PhotoMeta = Omit<Photo, 'blob' | 'thumbBlob' | 'pendingFull'>;

function metaOf(photo: Photo): PhotoMeta {
  const { blob: _blob, thumbBlob: _thumb, pendingFull: _pending, ...meta } = photo;
  return meta;
}

// --- transport ---------------------------------------------------------------

function endpoint(): string {
  return (
    (globalThis as { __POCABOX_PHOTO_ENDPOINT__?: string }).__POCABOX_PHOTO_ENDPOINT__ ??
    DEFAULT_ENDPOINT
  );
}

async function bearer(force: boolean): Promise<string> {
  // Automated tests mint their own token for a locally run Worker; a production
  // build never sets this global.
  const override = (globalThis as { __POCABOX_PHOTO_TOKEN__?: string }).__POCABOX_PHOTO_TOKEN__;
  if (override) return override;
  const token = await getIdToken(force);
  if (!token) throw new Error('尚未登入，無法同步照片');
  return token;
}

/**
 * Call the Worker with a fresh ID token, retrying once on 401.
 *
 * A 401 against a signed-in session means the cached token expired between
 * being read and being used, so re-minting it and trying again is the fix; a
 * second 401 is a real authorisation problem and is left to the caller.
 */
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${endpoint()}${path}`;
  const send = async (force: boolean) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await bearer(force)}` },
    });

  const first = await send(false);
  if (first.status !== 401) return first;
  return send(true);
}

async function expectOk(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  throw new Error(`${what} 失敗（HTTP ${res.status}）`);
}

/** Ids already stored in the cloud, so we only upload what is genuinely missing. */
async function cloudIds(): Promise<Set<ID>> {
  const res = await expectOk(await api('/photos'), '讀取雲端照片清單');
  const body = (await res.json()) as { ids?: unknown };
  return new Set(Array.isArray(body.ids) ? (body.ids as ID[]) : []);
}

// --- small helpers -----------------------------------------------------------

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run `worker` over `items`, at most `limit` at a time, preserving no order. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function readWatermark(key: string): Promise<string> {
  const row = await db.settings.get(key);
  return typeof row?.value === 'string' ? row.value : '';
}

/**
 * Every local photo's `updatedAt`, read from the index without loading a single
 * Blob. `Collection.get()` on a thousand photos would pull hundreds of MB into
 * memory just to compare timestamps; an index cursor exposes the primary key
 * alongside the key and touches no record values at all.
 */
async function localTimestamps(): Promise<Map<ID, string>> {
  const map = new Map<ID, string>();
  await db.photos.orderBy('updatedAt').eachKey((key, cursor) => {
    map.set(cursor.primaryKey as ID, key as string);
  });
  return map;
}

async function idsChangedSince(since: string): Promise<ID[]> {
  const collection = since ? db.photos.where('updatedAt').above(since) : db.photos.toCollection();
  return (await collection.primaryKeys()) as ID[];
}

// --- upload ------------------------------------------------------------------

async function putBinary(path: string, blob: Blob, what: string): Promise<void> {
  await expectOk(
    await api(path, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'image/webp' } }),
    what,
  );
}

/**
 * Send metadata for everything changed since the last push, and binaries for
 * everything the cloud does not have yet.
 *
 * The two sets differ — an edit changes metadata without changing pixels, and a
 * previously failed round leaves old photos still missing upstream — so both are
 * collected and the rows are loaded once for whichever applies.
 */
async function pushPhotos(fs: Firestore, uid: string): Promise<void> {
  const { doc, writeBatch } = await import('firebase/firestore');
  const since = await readWatermark(LAST_PUSHED_KEY);
  // Taken before reading anything: a photo added mid-push keeps a newer
  // timestamp and is caught next round rather than being skipped.
  const startedAt = new Date().toISOString();

  const changed = new Set(await idsChangedSince(since));
  const alive = new Set((await db.photos.where('isDeleted').equals(0).primaryKeys()) as ID[]);
  const remote = await cloudIds();
  const missing = new Set([...alive].filter((id) => !remote.has(id)));

  const work = [...new Set([...changed, ...missing])];
  if (work.length === 0) {
    await db.settings.put({ key: LAST_PUSHED_KEY, value: startedAt });
    return;
  }

  let done = 0;
  const total = missing.size;
  if (total > 0) setState({ state: 'uploading', done, total });

  for (const chunk of chunked(work, CHUNK)) {
    const rows = (await db.photos.bulkGet(chunk)).filter((r): r is Photo => Boolean(r));

    // Binaries first. If one fails the whole round throws and the watermark is
    // never written, so metadata cannot get ahead of the files it describes.
    const toUpload = rows.filter(
      // A pendingFull row's `blob` is only a thumbnail standing in for an image
      // still downloading — uploading it would replace the real one in the cloud
      // with a blurry copy. It came from the cloud anyway, so it is never in
      // `missing`; the check is here so that stays true if the sets ever change.
      (row) => missing.has(row.id) && row.pendingFull !== 1,
    );
    await pool(toUpload, PARALLEL, async (row) => {
      await putBinary(`/photos/${row.id}`, row.blob, '上傳照片');
      await putBinary(`/photos/${row.id}/thumb`, row.thumbBlob, '上傳縮圖');
      done += 1;
      setState({ state: 'uploading', done, total });
    });

    const metaRows = rows.filter((row) => changed.has(row.id));
    if (metaRows.length > 0) {
      const batch = writeBatch(fs);
      for (const row of metaRows) batch.set(doc(fs, `users/${uid}/photos/${row.id}`), metaOf(row));
      await batch.commit();
    }
  }

  await db.settings.put({ key: LAST_PUSHED_KEY, value: startedAt });
}

// --- download ----------------------------------------------------------------

/**
 * Store a photo we have never seen, using its thumbnail for both variants.
 *
 * The full image follows in the background; until it arrives `blob` is the
 * thumbnail and `pendingFull` says so. Every screen keeps working unchanged —
 * the card detail view is simply a little soft for a moment.
 */
async function downloadThumb(meta: PhotoMeta): Promise<void> {
  const res = await expectOk(await api(`/photos/${meta.id}/thumb`), '下載縮圖');
  const thumb = await res.blob();
  await db.photos.put({
    ...meta,
    blob: thumb,
    thumbBlob: thumb,
    // Reflects what this device is actually storing, which is what the storage
    // estimate in 設定 reports.
    bytes: thumb.size,
    pendingFull: 1,
  });
  // The card referencing this photo may already be on screen — it syncs before
  // the image does — so tell its tile the picture has arrived.
  invalidatePhotoUrl(meta.id);
}

/** Merge one remote metadata row, downloading its thumbnail if it is new here. */
async function absorb(meta: PhotoMeta, localAt: Map<ID, string>): Promise<void> {
  if (typeof meta?.id !== 'string' || typeof meta.updatedAt !== 'string') return;

  const mine = localAt.get(meta.id);
  if (mine !== undefined) {
    // Last write wins, and a tie leaves local alone — same rule as the metadata
    // engine. Spreading over the stored row keeps this device's Blobs and its
    // pendingFull marker, which the cloud copy knows nothing about.
    if (mine >= meta.updatedAt) return;
    const local = await db.photos.get(meta.id);
    if (!local) return;
    await db.photos.put({ ...local, ...meta });
    return;
  }

  // Deleted upstream and never present here: nothing to fetch.
  if (meta.isDeleted === 1) return;
  await downloadThumb(meta);
}

/**
 * Pull metadata and fetch thumbnails for anything new.
 *
 * Rows are processed oldest-first and the watermark only advances past those
 * that fully succeeded, so one unreachable file cannot make the rest of the
 * library retry forever — nor can it be silently skipped.
 */
async function pullPhotos(fs: Firestore, uid: string): Promise<void> {
  const { collection, getDocs, orderBy, query, where } = await import('firebase/firestore');
  const since = await readWatermark(LAST_PULLED_KEY);

  const ref = collection(fs, `users/${uid}/photos`);
  // `>=` rather than `>`: two rows can share a millisecond, and re-reading one
  // costs nothing because absorbing it is idempotent.
  const snap = await getDocs(
    since ? query(ref, where('updatedAt', '>=', since), orderBy('updatedAt')) : query(ref, orderBy('updatedAt')),
  );
  if (snap.empty) return;

  const remote = snap.docs.map((d) => d.data() as PhotoMeta);
  const localAt = await localTimestamps();
  const total = remote.filter((m) => !localAt.has(m.id) && m.isDeleted !== 1).length;

  let done = 0;
  let watermark = since;
  let blocked = false;
  if (total > 0) setState({ state: 'downloading', done, total });

  for (const chunk of chunked(remote, PARALLEL)) {
    const ok = await Promise.all(
      chunk.map(async (meta) => {
        try {
          const isNew = !localAt.has(meta.id) && meta.isDeleted !== 1;
          await absorb(meta, localAt);
          if (isNew) {
            done += 1;
            setState({ state: 'downloading', done, total });
          }
          return true;
        } catch (e) {
          console.error('photo download failed', meta.id, e);
          return false;
        }
      }),
    );

    for (let i = 0; i < chunk.length; i += 1) {
      if (!ok[i]) blocked = true;
      // Stops at the first failure, so the next round resumes from exactly
      // there instead of re-reading rows that already landed.
      if (!blocked) watermark = chunk[i].updatedAt;
    }
  }

  if (watermark && watermark !== since) {
    await db.settings.put({ key: LAST_PULLED_KEY, value: watermark });
  }
  if (blocked) throw new Error('部分照片下載失敗');
}

// --- background fill ---------------------------------------------------------

async function pendingFullIds(): Promise<ID[]> {
  return (await db.photos.where('pendingFull').equals(1).primaryKeys()) as ID[];
}

/** Replace one stand-in thumbnail with the real image. */
async function fillOne(id: ID): Promise<void> {
  const local = await db.photos.get(id);
  if (!local || local.pendingFull !== 1) return;

  const res = await api(`/photos/${id}`);
  if (res.status === 404) {
    // The thumbnail exists upstream but the full image does not — the only way
    // that happens is an upload interrupted between the two PUTs. Keep the
    // thumbnail and stop asking, rather than retrying forever.
    console.warn('full image missing in cloud, keeping thumbnail', id);
    const { pendingFull: _drop, ...kept } = local;
    await db.photos.put(kept);
    return;
  }
  await expectOk(res, '下載照片');
  const blob = await res.blob();

  const { pendingFull: _drop, ...kept } = local;
  // `updatedAt` is carried over untouched. Filling in a local Blob is not an
  // edit; bumping it would make this device look newer than the cloud and push
  // the row straight back up on the next round.
  await db.photos.put({ ...kept, blob, bytes: blob.size + local.thumbBlob.size });
  invalidatePhotoUrl(id);
}

let fillInFlight: Promise<void> | null = null;

/**
 * Fetch full images for everything still showing a thumbnail.
 *
 * Runs after a sync round returns rather than inside it, because a large first
 * download would otherwise keep the whole sync marked busy for minutes while
 * the collection is already usable. Deliberately keeps going when the tab is
 * hidden: the browser throttles background fetches anyway, and stopping would
 * leave someone who glanced at the app and switched away stuck at 5%.
 *
 * Concurrent callers share the run in progress instead of starting a second
 * one — and get a promise that resolves when it is actually finished, rather
 * than one that resolves immediately and looks like completion.
 */
export function fillFullImages(): Promise<void> {
  if (fillInFlight) return fillInFlight;
  // Filling in a downloaded image deliberately leaves `updatedAt` alone, so
  // these writes can never be worth pushing — and without this they would
  // schedule a pointless sync round for every photo that lands.
  const run = suppressLocalWrites(runFill);
  // Cleared from a callback, never from inside the body: an early return before
  // the first await would otherwise clear the slot before it was even assigned
  // and leave a settled promise parked here for the rest of the session.
  fillInFlight = run;
  void run.finally(() => {
    if (fillInFlight === run) fillInFlight = null;
  });
  return run;
}

async function runFill(): Promise<void> {
  const ids = await pendingFullIds();
  if (ids.length === 0) {
    if (state.state === 'filling') setState({ state: 'idle' });
    return;
  }

  let done = 0;
  const total = ids.length;
  setState({ state: 'filling', done, total });
  let failed = 0;

  await pool(ids, PARALLEL, async (id) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      await fillOne(id);
    } catch (e) {
      console.error('full image download failed', id, e);
      failed += 1;
      return;
    }
    done += 1;
    setState({ state: 'filling', done, total });
  });

  const left = await pendingFullIds();
  setState(
    failed > 0 && left.length > 0
      ? { state: 'idle', pendingFull: left.length }
      : { state: 'idle' },
  );
}

// --- entry point -------------------------------------------------------------

/**
 * One photo round: metadata both ways, missing uploads, thumbnails for anything
 * new, then full images in the background.
 *
 * Called by `engine.syncNow` after the card metadata is already in sync.
 */
export async function syncPhotos(fs: Firestore, uid: string): Promise<void> {
  await pushPhotos(fs, uid);
  await pullPhotos(fs, uid);
  setState({ state: 'idle' });
  // Not awaited: the collection is browsable now, the rest can trickle in.
  void fillFullImages();
}

export function reportPhotoSyncError(e: unknown): void {
  // A failed `fetch` throws a bare TypeError whose message is "Failed to fetch",
  // which tells a user nothing. Everything thrown deliberately in this module
  // is already written for a person to read, so only that case is translated.
  const raw = e instanceof Error ? e.message : '';
  const unreachable = e instanceof TypeError || raw === '' || /fetch/i.test(raw);
  setState({
    state: 'error',
    message: unreachable ? '連不上照片服務，稍後會自動重試。' : raw,
  });
}

/** Forget both photo watermarks so the next sync reconciles everything. */
export async function resetPhotoSyncState(): Promise<void> {
  await db.settings.delete(LAST_PUSHED_KEY);
  await db.settings.delete(LAST_PULLED_KEY);
  setState({ state: 'idle' });
}

// --- manual cloud cleanup ----------------------------------------------------

export interface CloudCleanupPlan {
  ids: ID[];
  /** Ids the cloud holds that no live card or folder cover refers to. */
  total: number;
}

/**
 * Find cloud photos nothing refers to any more.
 *
 * Deleting them automatically would be a trap: a device that removed a card has
 * no way of knowing whether another device has synced that removal yet, and the
 * photo may still be the only copy of an image a second card was about to use.
 * So this is an explicit action in 設定, and it reads the *local* library — run
 * it from a device that is fully synced.
 */
export async function planCloudCleanup(): Promise<CloudCleanupPlan> {
  const remote = await cloudIds();

  const referenced = new Set<ID>();
  await db.cards.each((card) => {
    if (card.isDeleted === 1) return;
    if (card.frontPhotoId) referenced.add(card.frontPhotoId);
    if (card.backPhotoId) referenced.add(card.backPhotoId);
  });
  await db.folders.each((folder) => {
    if (folder.isDeleted === 0 && folder.coverPhotoId) referenced.add(folder.coverPhotoId);
  });

  const ids = [...remote].filter((id) => !referenced.has(id));
  return { ids, total: ids.length };
}

/** Delete the given photos from the cloud, both variants. Local rows are untouched. */
export async function deleteCloudPhotos(ids: ID[]): Promise<number> {
  let deleted = 0;
  await pool(ids, PARALLEL, async (id) => {
    await expectOk(await api(`/photos/${id}`, { method: 'DELETE' }), '刪除雲端照片');
    await expectOk(await api(`/photos/${id}/thumb`, { method: 'DELETE' }), '刪除雲端縮圖');
    deleted += 1;
  });
  return deleted;
}
