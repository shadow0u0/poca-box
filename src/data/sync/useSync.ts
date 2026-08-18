import { useEffect, useState } from 'react';
import { getSyncStatus, onSyncStatus, startAutoSync, syncNow, type SyncStatus } from './engine';
import { getPhotoSyncState, onPhotoSyncState, type PhotoSyncState } from './photos';

/**
 * Runs background sync for as long as a signed-in account is present, and
 * exposes the current status. Passing `undefined` stops syncing, so signing out
 * tears the loop down.
 */
export function useSync(uid: string | undefined): {
  status: SyncStatus;
  syncNow: () => void;
} {
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus);

  useEffect(() => onSyncStatus(setStatus), []);

  useEffect(() => {
    if (!uid) return;
    return startAutoSync(uid);
  }, [uid]);

  return {
    status,
    syncNow: () => {
      if (uid) void syncNow(uid);
    },
  };
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
