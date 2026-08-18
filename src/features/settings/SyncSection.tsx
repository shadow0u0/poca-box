import { useState } from 'react';
import { IconWarning } from '../../components/icons';
import { ConfirmDialog } from '../../components/ui';
import { SYNC_ENABLED_KEY, useSyncEnabled } from '../../data/hooks';
import { repo } from '../../data/repo';
import { SignInError, signIn, signOut, useAuth } from '../../data/sync/auth';

/**
 * Cloud sync account controls.
 *
 * Sync is opt-in and the Firebase SDK only loads once it is on, so the section
 * renders its introduction without any network work for someone who has not
 * enabled it.
 */
export function SyncSection() {
  const enabled = useSyncEnabled();
  const auth = useAuth(enabled === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

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

  const stop = async () => {
    setBusy(true);
    try {
      await signOut();
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
            登入後，小卡資料與照片會同步到你自己的 Firebase 專案，iPhone、iPad 與電腦
            看到的都一樣。不登入的話，一切維持現狀 —— 資料只留在這台裝置。
            （同步功能開發中，目前只有登入可用。）
          </p>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
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
            已登入。<strong>資料同步本身還在開發中</strong> —— 目前登入只是先建立帳號連結，
            小卡還不會上傳。完成後這裡會顯示同步狀態。
          </p>
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
          <button
            type="button"
            className="btn-outline"
            disabled={busy}
            onClick={() => setConfirmOff(true)}
          >
            登出並關閉同步
          </button>
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
