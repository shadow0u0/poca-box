import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconChart, IconDownload, IconUpload, IconWarning } from '../../components/icons';
import { ConfirmDialog, Modal, PageHeader, Spinner } from '../../components/ui';
import {
  clearAllData,
  downloadBlob,
  exportBackup,
  importBackup,
  type ImportMode,
  type ImportResult,
} from '../../data/backup';
import {
  LAST_BACKUP_KEY,
  PHOTO_QUALITY_KEY,
  useCards,
  useCollections,
  usePhotoQuality,
  useSyncEnabled,
} from '../../data/hooks';
import { QUALITY_PRESETS, totalPhotoBytes } from '../../data/photos';
import { fetchCloudAccount, type CloudAccount } from '../../data/sync/photos';
import { useLiveQuery } from 'dexie-react-hooks';
import { repo } from '../../data/repo';
import { requestPersistentStorage } from '../../data/seed';
import { formatBytes, formatDate } from '../../lib/format';
import {
  discardPreMigrationSnapshot,
  exportPreMigrationSnapshot,
  getSnapshotInfo,
  type SnapshotInfo,
} from '../../data/upgrade';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { SyncSection } from './SyncSection';
import { TaxonomyEditor } from './TaxonomyEditor';

function StorageSection() {
  const cards = useCards();
  const syncEnabled = useSyncEnabled();
  const [photoBytes, setPhotoBytes] = useState<number | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [cloud, setCloud] = useState<CloudAccount | null>(null);

  useEffect(() => {
    void totalPhotoBytes().then(setPhotoBytes);
    void navigator.storage?.estimate?.().then((e) => {
      if (e.usage != null && e.quota != null) setQuota({ usage: e.usage, quota: e.quota });
    });
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, [cards]);

  useEffect(() => {
    // Only here, and only while signed in: working the number out means listing
    // the whole prefix, which is not something a sync round should pay for.
    if (!syncEnabled) return;
    void fetchCloudAccount(true)
      .then(setCloud)
      .catch(() => setCloud(null));
  }, [syncEnabled, cards]);

  return (
    <section className="card-surface p-4">
      <h2 className="mb-3 font-medium">儲存空間</h2>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted">小卡張數</dt>
          <dd className="text-lg font-medium">{cards?.length ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">照片佔用</dt>
          <dd className="text-lg font-medium">
            {photoBytes == null ? '—' : formatBytes(photoBytes)}
          </dd>
        </div>
        {quota && (
          <div className="col-span-2">
            <dt className="text-xs text-muted">瀏覽器配額</dt>
            <dd>
              已用 {formatBytes(quota.usage)} / 可用 {formatBytes(quota.quota)}
            </dd>
          </div>
        )}
        {cloud?.invited && cloud.usedBytes != null && (
          <div className="col-span-2">
            <dt className="text-xs text-muted">雲端照片空間</dt>
            <dd>
              已用 {formatBytes(cloud.usedBytes)} / 上限 {formatBytes(cloud.limitBytes)}
              <span
                className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-surface-2"
                role="presentation"
              >
                <span
                  className={`block h-full rounded-full ${
                    cloud.usedBytes / cloud.limitBytes > 0.9 ? 'bg-danger' : 'bg-accent'
                  }`}
                  style={{ width: `${Math.min(100, (cloud.usedBytes / cloud.limitBytes) * 100)}%` }}
                />
              </span>
            </dd>
          </div>
        )}
      </dl>

      {persisted === false && (
        <div className="mt-4 flex gap-3 rounded-xl bg-danger-soft p-3 text-sm text-danger">
          <IconWarning className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">尚未取得「持久化儲存」授權</p>
            <p className="mt-1 opacity-90">
              瀏覽器可能在長期未開啟時清除本機資料。建議把本 App「加入主畫面」安裝，並定期匯出備份。
            </p>
            <button
              type="button"
              className="btn-outline btn-sm mt-2"
              onClick={() => void requestPersistentStorage().then(setPersisted)}
            >
              重新申請
            </button>
          </div>
        </div>
      )}
      {persisted === true && (
        <p className="mt-3 text-xs text-muted">已取得持久化儲存授權，但仍建議定期匯出備份。</p>
      )}
    </section>
  );
}

/** Past this long without an export, 設定 says so rather than staying quiet. */
const BACKUP_STALE_DAYS = 30;

/**
 * How long since the last backup — silent while it is recent, insistent once it
 * is not, and quiet altogether for a collection with nothing in it yet.
 */
function BackupAge({ lastBackupAt, cardCount }: { lastBackupAt: string | null; cardCount: number }) {
  if (cardCount === 0) return null;

  if (!lastBackupAt) {
    return (
      <p className="mt-3 text-sm text-danger">
        還沒有匯出過備份。同步不等於備份 —— 誤刪會同步到每一台裝置。
      </p>
    );
  }

  const days = Math.floor((Date.now() - new Date(lastBackupAt).getTime()) / (24 * 60 * 60 * 1000));
  if (days >= BACKUP_STALE_DAYS) {
    return (
      <p className="mt-3 text-sm text-danger">
        已經 {days} 天沒有匯出備份了（上次是 {formatDate(lastBackupAt)}）。
      </p>
    );
  }
  return <p className="mt-3 text-xs text-muted">上次匯出備份：{formatDate(lastBackupAt)}</p>;
}

function BackupSection() {
  const cards = useCards();
  const lastBackupAt = useLiveQuery(
    async () => (await repo.settings.get<string>(LAST_BACKUP_KEY, '')) || null,
    [],
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doExport = async () => {
    setBusy('export');
    setError(null);
    try {
      const { blob, filename } = await exportBackup();
      downloadBlob(blob, filename);
      await repo.settings.set(LAST_BACKUP_KEY, new Date().toISOString());
    } catch (e) {
      console.error(e);
      setError('匯出失敗，請再試一次');
    } finally {
      setBusy(null);
    }
  };

  const doImport = async () => {
    if (!pendingFile) return;
    setBusy('import');
    setError(null);
    try {
      setResult(await importBackup(pendingFile, mode));
      setPendingFile(null);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : '匯入失敗');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <section className="card-surface p-4">
      <h2 className="font-medium">備份與轉移</h2>
      <p className="mt-0.5 mb-3 text-xs text-muted">
        備份檔包含所有小卡資料與照片，檔名為 <code>pocabox-backup-日期.zip</code>。
        這也是把收藏搬到另一台裝置的方法：在這裡匯出，到另一台裝置匯入。
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null}
          onClick={() => void doExport()}
        >
          <IconDownload className="h-4 w-4" />
          {busy === 'export' ? '匯出中…' : '匯出備份 (.zip)'}
        </button>
        <button
          type="button"
          className="btn-outline"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
        >
          <IconUpload className="h-4 w-4" />
          匯入備份
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            setMode('merge');
            setPendingFile(file);
          }
        }}
      />

      <BackupAge lastBackupAt={lastBackupAt ?? null} cardCount={cards?.length ?? 0} />

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <Modal
        open={!!pendingFile}
        onClose={() => setPendingFile(null)}
        title="匯入備份"
        footer={
          <>
            <button type="button" className="btn-outline" onClick={() => setPendingFile(null)}>
              取消
            </button>
            <button
              type="button"
              className={mode === 'replace' ? 'btn-danger' : 'btn-primary'}
              disabled={busy !== null}
              onClick={() => void doImport()}
            >
              {busy === 'import' ? '匯入中…' : '開始匯入'}
            </button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted">{pendingFile?.name}</p>
        <div className="flex flex-col gap-2">
          <label className="flex cursor-pointer gap-3 rounded-xl border border-border p-3">
            <input
              type="radio"
              name="import-mode"
              checked={mode === 'merge'}
              onChange={() => setMode('merge')}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium">合併（建議）</span>
              <span className="block text-xs text-muted">
                保留這台裝置現有的資料，只補上備份裡較新的內容。跨裝置搬移就用這個。
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer gap-3 rounded-xl border border-border p-3">
            <input
              type="radio"
              name="import-mode"
              checked={mode === 'replace'}
              onChange={() => setMode('replace')}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium">完全覆蓋</span>
              <span className="block text-xs text-danger">
                先清空這台裝置上的所有小卡，再還原備份內容。無法復原。
              </span>
            </span>
          </label>
        </div>
      </Modal>

      <Modal open={!!result} onClose={() => setResult(null)} title="匯入完成">
        <p className="text-sm">
          已{result?.mode === 'replace' ? '覆蓋還原' : '合併'} {result?.cards ?? 0} 張小卡、
          {result?.photos ?? 0} 張照片。
          {result?.skipped ? `有 ${result.skipped} 筆因為本機版本較新而略過。` : ''}
        </p>
      </Modal>
    </section>
  );
}

function AppearanceSection() {
  const { preference, setPreference } = useTheme();
  const quality = usePhotoQuality();

  const options: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: '跟隨系統' },
    { value: 'light', label: '淺色' },
    { value: 'dark', label: '深色' },
  ];

  return (
    <section className="card-surface p-4">
      <h2 className="mb-3 font-medium">外觀與照片</h2>

      <p className="label">主題</p>
      <div className="mb-4 flex gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={preference === o.value ? 'chip chip-active' : 'chip'}
            onClick={() => setPreference(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <p className="label">照片壓縮品質</p>
      <div className="flex flex-col gap-2">
        {QUALITY_PRESETS.map((preset) => {
          const active = quality.maxDimension === preset.value.maxDimension;
          return (
            <button
              key={preset.id}
              type="button"
              className={`rounded-xl border p-3 text-left transition-colors ${
                active ? 'border-accent bg-accent-soft' : 'border-border'
              }`}
              onClick={() => void repo.settings.set(PHOTO_QUALITY_KEY, preset.value)}
            >
              <span className="block text-sm font-medium">{preset.label}</span>
              <span className="block text-xs text-muted">{preset.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">只影響之後新增的照片，已存的照片不會重新壓縮。</p>
    </section>
  );
}

/**
 * Only rendered when an update actually migrated data. It gives the user a way
 * back that does not depend on them having exported a backup first.
 */
function RecoverySection() {
  const [info, setInfo] = useState<SnapshotInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getSnapshotInfo().then(setInfo);
  }, []);

  if (!info) return null;

  return (
    <section className="card-surface p-4">
      <h2 className="font-medium">升級前的自動備份</h2>
      <p className="mt-0.5 mb-3 text-xs text-muted">
        App 在更新資料格式（v{info.version} →）之前自動保留了當時的資料
        （{info.cards} 張小卡，{formatDate(info.takenAt.slice(0, 10))}）。
        如果更新後發現資料不對，可以下載成一般的備份檔留存或轉到其他裝置。照片不受資料格式更新影響。
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-outline"
          disabled={busy !== null}
          onClick={async () => {
            setBusy('export');
            setError(null);
            try {
              const result = await exportPreMigrationSnapshot();
              if (result) downloadBlob(result.blob, result.filename);
              else setError('找不到升級前的備份');
            } catch (e) {
              console.error(e);
              setError('下載失敗，請再試一次');
            } finally {
              setBusy(null);
            }
          }}
        >
          <IconDownload className="h-4 w-4" />
          {busy === 'export' ? '準備中…' : '下載升級前的資料'}
        </button>
        <button
          type="button"
          className="btn-ghost text-muted"
          disabled={busy !== null}
          onClick={async () => {
            setBusy('discard');
            await discardPreMigrationSnapshot();
            setInfo(null);
          }}
        >
          一切正常，清除這份備份
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}

function DangerSection() {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="card-surface border-danger/40 p-4">
      <h2 className="font-medium text-danger">清除所有資料</h2>
      <p className="mt-0.5 mb-3 text-xs text-muted">
        刪除這台裝置上的全部小卡、照片與分類設定。請先匯出備份。
      </p>
      <button type="button" className="btn-danger" onClick={() => setConfirming(true)}>
        清除所有資料
      </button>

      <ConfirmDialog
        open={confirming}
        title="確定要清除所有資料？"
        message="這台裝置上的所有小卡、照片、團體、收藏夾與套卡都會被刪除，而且無法復原。"
        confirmLabel="全部清除"
        destructive
        onConfirm={async () => {
          await clearAllData();
          setConfirming(false);
          // Reload so seeding runs again and every live query resets.
          window.location.reload();
        }}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}

export default function SettingsPage() {
  const collections = useCollections();
  if (!collections) return <Spinner />;

  return (
    <>
      <PageHeader
        title="設定"
        subtitle="分類、備份與外觀"
        actions={
          <Link to="/stats" className="btn-outline">
            <IconChart className="h-4 w-4" />
            收藏統計
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SyncSection />
        <RecoverySection />
        <StorageSection />
        <BackupSection />

        <TaxonomyEditor
          title="來源"
          hint="小卡是從哪裡來的。可以自由新增你自己的分類。"
          rows={collections.sources}
          field="sourceId"
          placeholder="新增來源，例如：生日應援"
          onCreate={async (name) => {
            await repo.sources.ensure(name);
          }}
          onRename={(id, name) => repo.sources.rename(id, name)}
          onRemove={(id) => repo.sources.remove(id)}
        />

        <TaxonomyEditor
          title="卡種"
          hint="官方小卡、福卡、簽名卡…依你自己的分類方式。"
          rows={collections.cardTypes}
          field="cardTypeId"
          placeholder="新增卡種"
          onCreate={async (name) => {
            await repo.cardTypes.ensure(name);
          }}
          onRename={(id, name) => repo.cardTypes.rename(id, name)}
          onRemove={(id) => repo.cardTypes.remove(id)}
        />

        <TaxonomyEditor
          title="持有狀態"
          hint="持有中、待交換、願望清單…"
          rows={collections.statuses}
          field="statusId"
          placeholder="新增狀態"
          onCreate={async (name) => {
            await repo.statuses.ensure(name);
          }}
          onRename={(id, name) => repo.statuses.rename(id, name)}
          onRemove={(id) => repo.statuses.remove(id)}
        />

        <TaxonomyEditor
          title="專輯／活動"
          hint="小卡的出處，例如專輯名、演唱會、快閃店。"
          rows={collections.albums}
          field="albumId"
          placeholder="新增專輯或活動"
          onCreate={async (name) => {
            await repo.albums.ensure(name);
          }}
          onRename={(id, name) => repo.albums.rename(id, name)}
          onRemove={(id) => repo.albums.remove(id)}
        />

        <TaxonomyEditor
          title="團體"
          hint="刪除團體不會刪除底下的成員資料，但小卡會失去團體標記。"
          rows={collections.groups}
          field="groupId"
          placeholder="新增團體"
          onCreate={async (name) => {
            await repo.groups.ensure(name);
          }}
          onRename={(id, name) => repo.groups.rename(id, name)}
          onRemove={(id) => repo.groups.remove(id)}
        />

        <AppearanceSection />
        <DangerSection />
      </div>

      <p className="mt-6 text-center text-xs text-muted">
        小卡櫃 · 未開啟雲端同步時，資料只存在這台裝置上。開啟後，文字資料會同步到雲端的
        Firebase 專案、照片存放在專屬的雲端空間，其他使用者都讀不到，但空間的管理者看得到。
      </p>
      {/* Which build is actually running — a service worker can keep serving an
          old one long after a deploy, and nothing else on screen gives it away. */}
      <p className="mt-1 text-center font-mono text-[11px] text-muted/70">
        v{__APP_VERSION__} · {__BUILD_ID__}
      </p>
    </>
  );
}
