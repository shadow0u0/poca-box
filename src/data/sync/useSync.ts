import { useEffect, useState } from 'react';
import { getSyncStatus, onSyncStatus, startAutoSync, type SyncStatus } from './engine';
import { getPhotoSyncState, onPhotoSyncState, type PhotoSyncState } from './photos';
import { useSyncEnabled } from '../hooks';
import { useAuth } from './auth';

/**
 * Drives background sync for as long as someone is signed in.
 *
 * Belongs to the app shell, not to a screen. It used to live in the 雲端同步
 * section of 設定, which meant `startAutoSync`'s interval only existed while
 * that page was mounted: a card added on the 卡片 page was not pushed until the
 * user happened to wander back into 設定. The user asked for sync that is
 * simply automatic, so this has to be mounted for as long as the app is.
 *
 * Call it exactly once, from `App`. A second call would start a second interval
 * — `syncNow` collapses overlapping rounds, so nothing would break, but there
 * is no reason to run two timers.
 */
export function useBackgroundSync(): void {
  const enabled = useSyncEnabled();
  // `useAuth(false)` touches no Firebase at all, so someone who never turned
  // sync on still pays nothing for it at startup.
  const auth = useAuth(enabled === true);
  const uid = auth.status === 'signed-in' ? auth.account.uid : undefined;

  useEffect(() => {
    if (!uid) return;
    return startAutoSync(uid);
  }, [uid]);
}

/** Live sync status for display. Observes only — it drives nothing. */
export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus);
  useEffect(() => onSyncStatus(setStatus), []);
  return status;
}

/**
 * Live photo transfer state. Kept apart from `SyncStatus` because filling in
 * full images carries on in the background after a sync round has already
 * finished — folding it in would leave the main status stuck on "syncing" for
 * minutes while the collection is perfectly usable.
 */
export function usePhotoSyncState(): PhotoSyncState {
  const [state, setState] = useState<PhotoSyncState>(getPhotoSyncState);
  useEffect(() => onPhotoSyncState(setState), []);
  return state;
}
