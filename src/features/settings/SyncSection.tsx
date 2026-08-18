import { useState } from 'react';
import { IconWarning } from '../../components/icons';
import { ConfirmDialog } from '../../components/ui';
import { SYNC_ENABLED_KEY, useSyncEnabled } from '../../data/hooks';
import { repo } from '../../data/repo';
import { SignInError, preloadSignIn, signIn, signOut, useAuth } from '../../data/sync/auth';
import { useSync, usePhotoSyncState } from '../../data/sync/useSync';
import { resetSyncState, type SyncStatus } from '../../data/sync/engine';
import { deleteCloudPhotos, planCloudCleanup, type PhotoSyncState } from '../../data/sync/photos';

/**
 * Cloud sync account controls.
 *
 * Sync is opt-in and the Firebase SDK only loads once it is on, so the section
 * renders its introduction without any network work for someone who has not
 * enabled it.
 */
/** Compact live view of what sync is doing right now. */
function SyncStatusRow({
  status,
  onRetry,
}: {
  status: SyncStatus;
  onRetry: () => void;
}) {
  const dot =
    status.state === 'syncing'
      ? 'bg-accent animate-pulse'
      : status.state === 'error'
        ? 'bg-danger'
        : status.state === 'offline'
          ? 'bg-muted'
          : 'bg-emerald-500';

  const label =
    status.state === 'syncing'
      ? '同步中…'
      : status.state === 'offline'
        ? '離線，連上網路後會自動同步'
        : status.state === 'error'
          ? status.message
          : status.last
            ? `已同步 · ${formatTime(status.last.finishedAt)}`
            : '等待同步';

  return (
    <div className="mb-3 flex items-center gap-2.5 rounded-xl bg-surface-2 px-3 py-2.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      {status.state !== 'syncing' && (
        <button type="button" className="btn-ghost btn-sm text-accent" onClick={onRetry}>
          立即同步
        </button>
      )}
    </div>
  );
}

/**
 * Photo transfer, on its own line.
 *
 * Photos move separately from the text and take far longer, so collapsing both
 * into one status would either hide a long download or make an already-usable
 * collection look unfinished.
 */
function PhotoSyncRow({ state }: { state: PhotoSyncState }) {
  const label = describePhotos(state);
  const progress =
    state.state === 'uploading' || state.state === 'downloading' || state.state === 'filling'
      ? state.total > 0
        ? Math.round((state.done / state.total) * 100)
        : 100
      : null;

  return (
    <div className="mb-3 rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            state.state === 'error'
              ? 'bg-danger'
              : progress !== null
                ? 'bg-accent animate-pulse'
                : 'bg-emerald-500'
          }`}
        />
        <span className="min-w-0 flex-1 text-sm">{label}</span>
      </div>
      {progress !== null && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface">
          <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}

function describePhotos(state: PhotoSyncState): string {
  switch (state.state) {
    case 'uploading':
      return `照片上傳中 ${state.done}/${state.total}`;
    case 'downloading':
      return `下載縮圖 ${state.done}/${state.total} —— 完成後列表就能看`;
    case 'filling':
      return `補齊原圖 ${state.done}/${state.total} —— 現在已經可以正常瀏覽`;
    case 'error':
      return state.message;
    default:
      return state.pendingFull
        ? `還有 ${state.pendingFull} 張原圖沒下載完，下次同步會再試`
        : '照片已同步';
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

export function SyncSection() {
  const enabled = useSyncEnabled();
  const auth = useAuth(enabled === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [cleanup, setCleanup] = useState<{ ids: string[] } | null>(null);
  const [cleanupNote, setCleanupNote] = useState<string | null>(null);
  const uid = auth.status === 'signed-in' ? auth.account.uid : undefined;
  const sync = useSync(uid);
  const photos = usePhotoSyncState();

  // `undefined` means the setting is still loading from IndexedDB.
  if (enabled === undefined) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await repo.settings.set(SYNC_ENABLED_KEY, true);
      await signIn();
    } catch (e) {
      // Leave sync switched off if the very first sign-in did not complete,
      // so the section does not sit in a half-enabled state.
      if (auth.status !== 'signed-in') await repo.settings.set(SYNC_ENABLED_KEY, false);
      setError(e instanceof SignInError ? e.message : '登入失敗，請再試一次。');
    } finally {
      setBusy(false);
    }
  };

  // Deliberately two steps: work out what would go, show the number, and only
  // delete after an explicit yes. Cloud photos are never removed automatically
  // because a device that deleted a card cannot know whether the others have
  // caught up yet.
  const findUnused = async () => {
    setBusy(true);
    setError(null);
    setCleanupNote(null);
    try {
      const plan = await planCloudCleanup();
      if (plan.total === 0) {
        setCleanupNote('雲端沒有多餘的照片，不需要清理。');
      } else {
        setCleanup({ ids: plan.ids });
      }
    } catch (e) {
      console.error(e);
      setError('無法讀取雲端照片清單，請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const runCleanup = async () => {
    if (!cleanup) return;
    setBusy(true);
    try {
      const deleted = await deleteCloudPhotos(cleanup.ids);
      setCleanupNote(`已刪除雲端 ${deleted} 張照片。`);
      setCleanup(null);
    } catch (e) {
      console.error(e);
      setError('刪除時發生錯誤，已刪除的部分不會回復，可以再執行一次。');
      setCleanup(null);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await signOut();
      await resetSyncState();
      await repo.settings.set(SYNC_ENABLED_KEY, false);
      setConfirmOff(false);
    } catch (e) {
      console.error(e);
      setError('登出失敗，請再試一次。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card-surface p-4">
      <h2 className="font-medium">雲端同步</h2>

      {!enabled || auth.status === 'signed-out' ? (
        <>
          <p className="mt-0.5 mb-3 text-xs text-muted">
            登入後，小卡資料與照片會同步到你自己的雲端空間，iPhone、iPad 與電腦
            看到的都一樣。不登入的話，一切維持現狀 —— 資料只留在這台裝置。
          </p>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            // Warmed on press rather than on render: someone who never signs in
            // should not pay for the Firebase SDK, but by the time the finger
            // lifts it is loaded, so the popup opens while the tap still counts.
            onPointerDown={() => void preloadSignIn().catch(() => {})}
            onClick={() => void start()}
          >
            {busy ? '登入中…' : '用 Google 帳號登入'}
          </button>
        </>
      ) : auth.status === 'loading' ? (
        <p className="mt-2 text-sm text-muted">讀取登入狀態…</p>
      ) : (
        <>
          <p className="mt-0.5 mb-3 text-xs text-muted">
            已登入，資料與照片都會自動同步。新裝置會先下載縮圖讓你立刻能翻，
            原圖在背景慢慢補齊。
          </p>
          <SyncStatusRow status={sync.status} onRetry={sync.syncNow} />
          <PhotoSyncRow state={photos} />
          <div className="mb-3 flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
            {auth.account.photoURL ? (
              <img src={auth.account.photoURL} alt="" className="h-9 w-9 rounded-full" />
            ) : (
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-on-accent">
                {(auth.account.displayName ?? auth.account.email ?? '?').slice(0, 1)}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {auth.account.displayName ?? '已登入'}
              </span>
              <span className="block truncate text-xs text-muted">{auth.account.email}</span>
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-outline"
              disabled={busy}
              onClick={() => setConfirmOff(true)}
            >
              登出並關閉同步
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => void findUnused()}
            >
              清理雲端未使用的照片
            </button>
          </div>
          {cleanupNote && <p className="mt-2 text-xs text-muted">{cleanupNote}</p>}
        </>
      )}

      {error && (
        <div className="mt-3 flex gap-2 rounded-xl bg-danger-soft p-3 text-sm text-danger">
          <IconWarning className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <p className="mt-3 text-xs text-muted">
        同步不等於備份 —— 誤刪會同步到每一台裝置。定期匯出備份仍然是唯一能回到某個時間點的方法。
      </p>

      <ConfirmDialog
        open={cleanup !== null}
        title="刪除雲端多餘的照片？"
        message={`雲端有 ${cleanup?.ids.length ?? 0} 張照片，這台裝置上已經沒有任何小卡或收藏夾封面用到它們。請先確認這台裝置已經同步完成 —— 若有另一台裝置剛加了小卡還沒同步過來，那些照片也會被算成多餘的。本機的照片不受影響。`}
        confirmLabel="刪除"
        onConfirm={() => void runCleanup()}
        onCancel={() => setCleanup(null)}
      />

      <ConfirmDialog
        open={confirmOff}
        title="登出並關閉同步？"
        message="這台裝置上的小卡資料會保留，只是不再與雲端同步。雲端上的資料不會被刪除。"
        confirmLabel="登出"
        onConfirm={() => void stop()}
        onCancel={() => setConfirmOff(false)}
      />
    </section>
  );
}
