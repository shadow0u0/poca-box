import imageCompression from 'browser-image-compression';
import { useEffect, useState } from 'react';
import { db } from './db';
import { newId, nowIso } from '../lib/id';
import type { ID, Photo } from './types';

/**
 * Photo storage: compress on the way in, hand out object URLs on the way out.
 *
 * A phone camera shot is 3–8 MB; kept as-is a 500-card collection would blow
 * past every browser's storage budget (and iOS is the stingiest). Each photo is
 * therefore stored twice — a display-size version and a grid thumbnail — which
 * together land around 150–250 KB.
 */

export interface PhotoQuality {
  /** Longest edge of the stored full-size image, in pixels. */
  maxDimension: number;
  /** 0–1 encoder quality. */
  quality: number;
}

export const DEFAULT_QUALITY: PhotoQuality = { maxDimension: 1600, quality: 0.82 };
export const QUALITY_PRESETS: { id: string; label: string; hint: string; value: PhotoQuality }[] = [
  { id: 'high', label: '高畫質', hint: '長邊 2200px，約 350 KB／張', value: { maxDimension: 2200, quality: 0.85 } },
  { id: 'balanced', label: '標準（建議）', hint: '長邊 1600px，約 180 KB／張', value: DEFAULT_QUALITY },
  { id: 'compact', label: '省空間', hint: '長邊 1200px，約 90 KB／張', value: { maxDimension: 1200, quality: 0.75 } },
];

const THUMB_DIMENSION = 420;

async function measure(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('無法讀取圖片'));
    };
    img.src = url;
  });
}

/** Compress, measure and persist one picked file. Returns the stored row. */
export async function storePhoto(file: File, quality: PhotoQuality = DEFAULT_QUALITY): Promise<Photo> {
  const [full, thumb] = await Promise.all([
    imageCompression(file, {
      maxWidthOrHeight: quality.maxDimension,
      initialQuality: quality.quality,
      fileType: 'image/webp',
      useWebWorker: true,
    }),
    imageCompression(file, {
      maxWidthOrHeight: THUMB_DIMENSION,
      initialQuality: 0.7,
      fileType: 'image/webp',
      useWebWorker: true,
    }),
  ]);

  const { width, height } = await measure(full);
  const now = nowIso();
  const photo: Photo = {
    id: newId(),
    // Store as plain Blobs: a File carries a name and lastModified that survive
    // structured cloning for no benefit here.
    blob: new Blob([await full.arrayBuffer()], { type: full.type }),
    thumbBlob: new Blob([await thumb.arrayBuffer()], { type: thumb.type }),
    mime: full.type || 'image/webp',
    width,
    height,
    bytes: full.size + thumb.size,
    createdAt: now,
    updatedAt: now,
    isDeleted: 0,
  };
  await db.photos.add(photo);
  return photo;
}

/** Insert an already-decoded photo (used by backup restore). */
export async function putPhoto(photo: Photo): Promise<void> {
  await db.photos.put(photo);
}

type Variant = 'thumb' | 'full';

interface CacheEntry {
  url: string;
  refs: number;
}

// Object URLs are refcounted so a scrolling grid reuses one URL per photo and
// the browser reclaims the blob as soon as nothing is showing it.
const urlCache = new Map<string, CacheEntry>();

async function acquireUrl(id: ID, variant: Variant): Promise<string | null> {
  const key = `${id}:${variant}`;
  const cached = urlCache.get(key);
  if (cached) {
    cached.refs += 1;
    return cached.url;
  }
  const photo = await db.photos.get(id);
  if (!photo) return null;
  const blob = variant === 'thumb' ? photo.thumbBlob : photo.blob;
  const entry: CacheEntry = { url: URL.createObjectURL(blob), refs: 1 };
  urlCache.set(key, entry);
  return entry.url;
}

function releaseUrl(id: ID, variant: Variant): void {
  const key = `${id}:${variant}`;
  const entry = urlCache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    URL.revokeObjectURL(entry.url);
    urlCache.delete(key);
  }
}

// Views showing a given photo, so they can be told when its bytes change.
// Cloud sync writes photos long after the cards that reference them: a tile
// that mounted while the image was still downloading would otherwise sit on its
// placeholder until the page was reloaded, because nothing about the *card*
// changed when the photo finally arrived.
const watchers = new Map<ID, Set<() => void>>();

function watchPhoto(id: ID, onChange: () => void): () => void {
  let set = watchers.get(id);
  if (!set) {
    set = new Set();
    watchers.set(id, set);
  }
  set.add(onChange);
  return () => {
    set.delete(onChange);
    if (set.size === 0) watchers.delete(id);
  };
}

/**
 * Drop a cached URL after its photo changed or was deleted, and tell anything
 * displaying it to fetch the new version.
 */
export function invalidatePhotoUrl(id: ID): void {
  for (const variant of ['thumb', 'full'] as const) {
    const key = `${id}:${variant}`;
    const entry = urlCache.get(key);
    if (entry) {
      URL.revokeObjectURL(entry.url);
      urlCache.delete(key);
    }
  }
  for (const notify of watchers.get(id) ?? []) notify();
}

/** Displayable URL for a stored photo, released automatically on unmount. */
export function usePhotoUrl(id: ID | undefined, variant: Variant = 'thumb'): string | null {
  const [url, setUrl] = useState<string | null>(null);
  // Bumped when the photo's bytes change under us — a sync download landing, or
  // the full image replacing the thumbnail that was standing in for it.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!id) return;
    return watchPhoto(id, () => setRevision((n) => n + 1));
  }, [id]);

  useEffect(() => {
    if (!id) {
      setUrl(null);
      return;
    }
    // `acquired` guards against releasing a reference this effect never took —
    // the cleanup can run before the lookup resolves.
    let acquired = false;
    let cancelled = false;
    void acquireUrl(id, variant).then((next) => {
      acquired = next !== null;
      if (cancelled) {
        if (acquired) releaseUrl(id, variant);
        return;
      }
      setUrl(next);
    });
    return () => {
      cancelled = true;
      setUrl(null);
      if (acquired) releaseUrl(id, variant);
    };
  }, [id, variant, revision]);

  return url;
}

export async function totalPhotoBytes(): Promise<number> {
  let total = 0;
  await db.photos.each((p) => {
    total += p.bytes;
  });
  return total;
}
