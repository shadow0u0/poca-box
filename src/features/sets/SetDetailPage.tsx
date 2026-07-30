import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CardTile } from '../../components/CardTile';
import { IconPlus, IconTrash, IconX } from '../../components/icons';
import {
  ConfirmDialog,
  Modal,
  PageHeader,
  ProgressBar,
  Spinner,
} from '../../components/ui';
import { useCards, useCollections, useNameLookup } from '../../data/hooks';
import { usePhotoUrl } from '../../data/photos';
import { repo } from '../../data/repo';
import { newId } from '../../lib/id';
import type { Card, CardSet, SetSlot } from '../../data/types';
import { setProgress } from './SetsPage';

function FilledSlot({ card, label }: { card: Card; label: string }) {
  const url = usePhotoUrl(card.frontPhotoId, 'thumb');
  return (
    <Link to={`/cards/${card.id}`} className="block">
      <div className="aspect-photocard overflow-hidden rounded-xl bg-surface-2">
        {url ? (
          <img src={url} alt={card.name} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center px-2 text-center text-xs text-muted">
            {card.name}
          </div>
        )}
      </div>
      <p className="mt-1 truncate text-sm font-medium">{label}</p>
      <p className="truncate text-xs text-muted">{card.name}</p>
    </Link>
  );
}

function EmptySlot({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        className="aspect-photocard flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border bg-surface-2/60 text-muted transition-colors hover:border-accent hover:text-accent"
      >
        <IconPlus className="h-5 w-5" />
        <span className="text-xs">尚未收集</span>
      </button>
      <p className="mt-1 truncate text-sm font-medium text-muted">{label}</p>
    </div>
  );
}

export default function SetDetailPage() {
  const { setId } = useParams();
  const navigate = useNavigate();
  const collections = useCollections();
  const cards = useCards();
  const names = useNameLookup(collections);

  const [assigning, setAssigning] = useState<SetSlot | null>(null);
  const [addSlotOpen, setAddSlotOpen] = useState(false);
  const [newSlotLabel, setNewSlotLabel] = useState('');
  const [deletingSet, setDeletingSet] = useState(false);
  const [removingSlot, setRemovingSlot] = useState<SetSlot | null>(null);

  const set = collections?.sets.find((s) => s.id === setId);

  /** slotId → the card currently filling it. */
  const bySlot = useMemo(() => {
    const map = new Map<string, Card>();
    for (const card of cards ?? []) {
      if (card.setId === setId && card.setSlotId) map.set(card.setSlotId, card);
    }
    return map;
  }, [cards, setId]);

  // Cards that could fill a slot: same group where the set has one, and not
  // already placed in this set.
  const candidates = useMemo(() => {
    if (!set || !cards) return [];
    return cards.filter((card) => {
      if (card.setId === set.id) return false;
      if (set.groupId && card.groupId !== set.groupId) return false;
      return true;
    });
  }, [cards, set]);

  const slotCandidates = useMemo(() => {
    if (!assigning) return candidates;
    // Float the matching member's cards to the top of the list.
    if (!assigning.memberId) return candidates;
    const memberId = assigning.memberId;
    return [...candidates].sort((a, b) => {
      const aHas = a.memberIds.includes(memberId) ? 0 : 1;
      const bHas = b.memberIds.includes(memberId) ? 0 : 1;
      return aHas - bHas;
    });
  }, [candidates, assigning]);

  if (!collections || !cards) return <Spinner />;
  if (!set) {
    return (
      <>
        <PageHeader title="找不到這套套卡" back="/sets" />
        <p className="text-sm text-muted">它可能已經被刪除了。</p>
      </>
    );
  }

  const { filled, total } = setProgress(set, cards);
  const missing = set.slots.filter((s) => !bySlot.has(s.id));

  const addSlot = async () => {
    const label = newSlotLabel.trim();
    if (!label) return;
    const slot: SetSlot = { id: newId(), label };
    await repo.cardSets.update(set.id, { slots: [...set.slots, slot] } as Partial<CardSet>);
    setNewSlotLabel('');
    setAddSlotOpen(false);
  };

  const removeSlot = async (slot: SetSlot) => {
    const occupant = bySlot.get(slot.id);
    if (occupant) await repo.cards.clearSlot(occupant.id);
    await repo.cardSets.update(set.id, {
      slots: set.slots.filter((s) => s.id !== slot.id),
    } as Partial<CardSet>);
    setRemovingSlot(null);
  };

  const removeSet = async () => {
    // Release every card first so none keeps pointing at a deleted set.
    for (const card of cards.filter((c) => c.setId === set.id)) {
      await repo.cards.clearSlot(card.id);
    }
    await repo.cardSets.remove(set.id);
    navigate('/sets', { replace: true });
  };

  return (
    <>
      <PageHeader
        title={set.name}
        subtitle={[
          set.groupId ? names.group.get(set.groupId) : null,
          set.albumId ? names.album.get(set.albumId) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        back="/sets"
        actions={
          <button
            type="button"
            aria-label="刪除套卡"
            className="btn-danger"
            onClick={() => setDeletingSet(true)}
          >
            <IconTrash className="h-4 w-4" />
          </button>
        }
      />

      <div className="card-surface mb-5 p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-medium">收集進度</span>
          <span className="text-sm text-muted">
            {filled} / {total}
          </span>
        </div>
        <ProgressBar value={filled} max={total} />
        {missing.length > 0 ? (
          <p className="mt-2 text-sm text-muted">
            還缺：{missing.map((s) => s.label).join('、')}
          </p>
        ) : total > 0 ? (
          <p className="mt-2 text-sm text-accent">這套已經收齊了 🎉</p>
        ) : (
          <p className="mt-2 text-sm text-muted">這套還沒有任何格位，先新增一個吧。</p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {set.slots.map((slot) => {
          const card = bySlot.get(slot.id);
          return (
            <div key={slot.id} className="group relative">
              {card ? (
                <FilledSlot card={card} label={slot.label} />
              ) : (
                <EmptySlot label={slot.label} onClick={() => setAssigning(slot)} />
              )}
              <button
                type="button"
                aria-label={`移除格位 ${slot.label}`}
                className="absolute -top-1.5 -right-1.5 rounded-full border border-border bg-surface p-1 text-muted opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                onClick={() => setRemovingSlot(slot)}
              >
                <IconX className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        <div>
          <button
            type="button"
            onClick={() => setAddSlotOpen(true)}
            className="aspect-photocard flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <IconPlus className="h-5 w-5" />
            <span className="text-xs">新增格位</span>
          </button>
          {/* Spacer matching the slot labels, so this tile lines up with them. */}
          <p className="mt-1 text-sm" aria-hidden="true">
            &nbsp;
          </p>
        </div>
      </div>

      {/* Assign a card to one slot */}
      <Modal
        open={!!assigning}
        onClose={() => setAssigning(null)}
        title={assigning ? `指派小卡給「${assigning.label}」` : ''}
        wide
      >
        <Link
          to={`/cards/new?set=${set.id}&slot=${assigning?.id ?? ''}${
            set.groupId ? `&group=${set.groupId}` : ''
          }${assigning?.memberId ? `&member=${assigning.memberId}` : ''}`}
          className="btn-primary mb-4 w-full"
        >
          <IconPlus className="h-4 w-4" />
          新增一張小卡填入這格
        </Link>

        {slotCandidates.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            沒有可指派的小卡{set.groupId ? '（只顯示同團體的小卡）' : ''}。
          </p>
        ) : (
          <>
            <p className="label">或從現有小卡挑一張</p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {slotCandidates.slice(0, 24).map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="text-left"
                  onClick={async () => {
                    if (!assigning) return;
                    await repo.cards.assignToSlot(card.id, set.id, assigning.id);
                    setAssigning(null);
                  }}
                >
                  <CardTile card={card} selectable selected={false} onToggle={() => {}} />
                </button>
              ))}
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={addSlotOpen}
        onClose={() => setAddSlotOpen(false)}
        title="新增格位"
        footer={
          <>
            <button type="button" className="btn-outline" onClick={() => setAddSlotOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!newSlotLabel.trim()}
              onClick={() => void addSlot()}
            >
              新增
            </button>
          </>
        }
      >
        <input
          autoFocus
          className="field"
          placeholder="例如：雙人卡、隱藏卡"
          value={newSlotLabel}
          onChange={(e) => setNewSlotLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void addSlot();
            }
          }}
        />
      </Modal>

      <ConfirmDialog
        open={!!removingSlot}
        title="移除這個格位？"
        message={
          removingSlot
            ? `「${removingSlot.label}」會從這套移除。已放進去的小卡本身不會被刪除。`
            : ''
        }
        confirmLabel="移除"
        destructive
        onConfirm={() => removingSlot && void removeSlot(removingSlot)}
        onCancel={() => setRemovingSlot(null)}
      />

      <ConfirmDialog
        open={deletingSet}
        title="刪除這套套卡？"
        message={`「${set.name}」會被移除，裡面的小卡本身不會被刪除。`}
        confirmLabel="刪除"
        destructive
        onConfirm={() => void removeSet()}
        onCancel={() => setDeletingSet(false)}
      />
    </>
  );
}
