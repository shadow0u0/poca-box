import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Combobox } from '../../components/Combobox';
import { IconGrid, IconPlus } from '../../components/icons';
import { EmptyState, Field, Modal, PageHeader, ProgressBar, Spinner } from '../../components/ui';
import { useCards, useCollections } from '../../data/hooks';
import { repo, slotsForMembers } from '../../data/repo';
import type { Card, CardSet } from '../../data/types';

/**
 * How many of a set's slots are filled. Derived from the cards themselves so a
 * deleted or reassigned card updates the progress with no bookkeeping.
 */
export function setProgress(set: CardSet, cards: Card[]): { filled: number; total: number } {
  const slotIds = new Set(set.slots.map((s) => s.id));
  const filled = new Set(
    cards
      .filter((c) => c.setId === set.id && c.setSlotId && slotIds.has(c.setSlotId))
      .map((c) => c.setSlotId!),
  );
  return { filled: filled.size, total: set.slots.length };
}

function CreateSetModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const collections = useCollections();
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState<string | undefined>();
  const [albumId, setAlbumId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const members = useMemo(
    () => (collections?.members ?? []).filter((m) => m.groupId === groupId),
    [collections, groupId],
  );

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await repo.cardSets.ensure(trimmed, {
        groupId,
        albumId,
        // One slot per member of the chosen group; editable afterwards.
        slots: slotsForMembers(members),
      });
      setName('');
      setGroupId(undefined);
      setAlbumId(undefined);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="建立套卡"
      footer={
        <>
          <button type="button" className="btn-outline" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!name.trim() || busy}
            onClick={() => void create()}
          >
            建立
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="套卡名稱">
          <input
            autoFocus
            className="field"
            placeholder="例如：LOVE DIVE 專輯全員套卡"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Combobox
          label="團體"
          value={groupId}
          options={(collections?.groups ?? []).map((g) => ({ id: g.id, label: g.name }))}
          onChange={setGroupId}
          onCreate={async (n) => (await repo.groups.ensure(n)).id}
        />

        <Combobox
          label="專輯／活動（選填）"
          value={albumId}
          options={(collections?.albums ?? []).map((a) => ({ id: a.id, label: a.name }))}
          onChange={setAlbumId}
          onCreate={async (n) => (await repo.albums.ensure(n, { groupId })).id}
        />

        <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted">
          {groupId
            ? members.length > 0
              ? `會自動依 ${members.length} 位成員建立 ${members.length} 個格位，之後可以再增減。`
              : '這個團體還沒有成員，建立後可以手動新增格位。'
            : '選擇團體後會自動依成員建立格位。'}
        </p>
      </div>
    </Modal>
  );
}

export default function SetsPage() {
  const collections = useCollections();
  const cards = useCards();
  const [createOpen, setCreateOpen] = useState(false);

  if (!collections || !cards) return <Spinner />;

  return (
    <>
      <PageHeader
        title="套卡"
        subtitle={collections.sets.length ? `${collections.sets.length} 套` : undefined}
        actions={
          <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
            <IconPlus className="h-4 w-4" />
            建立套卡
          </button>
        }
      />

      {collections.sets.length === 0 ? (
        <EmptyState
          icon={<IconGrid />}
          title="還沒有套卡"
          hint="建立團體全員套卡後，App 會自動算出收集進度，一眼看出還缺哪位成員。"
          action={
            <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
              <IconPlus className="h-4 w-4" />
              建立套卡
            </button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {collections.sets.map((set) => {
            const { filled, total } = setProgress(set, cards);
            const complete = total > 0 && filled === total;
            return (
              <Link key={set.id} to={`/sets/${set.id}`} className="card-surface block p-4">
                <div className="mb-1 flex items-start gap-2">
                  <p className="min-w-0 flex-1 truncate font-medium">{set.name}</p>
                  {complete && (
                    <span className="chip chip-active shrink-0 text-[11px]">已收齊</span>
                  )}
                </div>
                <p className="mb-3 text-xs text-muted">
                  {set.groupId ? collections.groups.find((g) => g.id === set.groupId)?.name : '未指定團體'}
                </p>
                <ProgressBar value={filled} max={total} />
                <p className="mt-1.5 text-sm text-muted">
                  {filled} / {total}
                </p>
              </Link>
            );
          })}
        </div>
      )}

      <CreateSetModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
