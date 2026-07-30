import { useEffect, useRef, useState } from 'react';
import { IconDownload, IconUpload, IconWarning } from '../../components/icons';
import { ConfirmDialog, Modal, PageHeader, Spinner } from '../../components/ui';
import {
  clearAllData,
  downloadBlob,
  exportBackup,
  importBackup,
  type ImportMode,
  type ImportResult,
} from '../../data/backup';
import { PHOTO_QUALITY_KEY, useCards, useCollections, usePhotoQuality } from '../../data/hooks';
import { QUALITY_PRESETS, totalPhotoBytes } from '../../data/photos';
import { repo } from '../../data/repo';
import { requestPersistentStorage } from '../../data/seed';
import { formatBytes } from '../../lib/format';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { TaxonomyEditor } from './TaxonomyEditor';

function StorageSection() {
  const cards = useCards();
  const [photoBytes, setPhotoBytes] = useState<number | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);

  useEffect(() => {
    void totalPhotoBytes().then(setPhotoBytes);
    void navigator.storage?.estimate?.().then((e) => {
      if (e.usage != null && e.quota != null) setQuota({ usage: e.usage, quota: e.quota });
    });
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, [cards]);

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

function BackupSection() {
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
      <PageHeader title="設定" subtitle="分類、備份與外觀" />

      <div className="grid gap-4 lg:grid-cols-2">
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
        小卡櫃 · 所有資料都只存在你自己的裝置上，不會上傳到任何伺服器。
      </p>
    </>
  );
}
