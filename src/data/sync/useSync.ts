import { useEffect, useState } from 'react';
import { getSyncStatus, onSyncStatus, startAutoSync, syncNow, type SyncStatus } from './engine';

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
