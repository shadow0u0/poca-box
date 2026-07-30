import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconImage, IconPlus, IconUsers } from '../../components/icons';
import { EmptyState, Modal, PageHeader, Spinner } from '../../components/ui';
import { useCards, useCollections } from '../../data/hooks';
import { usePhotoUrl } from '../../data/photos';
import { repo } from '../../data/repo';
import type { Card } from '../../data/types';

function Cover({ photoId, alt }: { photoId?: string; alt: string }) {
  const url = usePhotoUrl(photoId, 'thumb');
  return (
    <div className="aspect-[4/3] overflow-hidden rounded-xl bg-surface-2">
      {url ? (
        <img src={url} alt={alt} loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center text-muted">
          <IconImage className="h-6 w-6" />
        </div>
      )}
    </div>
  );
}

/** Newest card carrying a photo, used as a group's or member's cover. */
export function coverPhotoId(cards: Card[]): string | undefined {
  return cards.find((c) => c.frontPhotoId)?.frontPhotoId;
}

export function NewNameModal({
  open,
  title,
  placeholder,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  placeholder: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      setName('');
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn-outline" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
            建立
          </button>
        </>
      }
    >
      <input
        autoFocus
        className="field"
        placeholder={placeholder}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
    </Modal>
  );
}

export default function GroupsPage() {
  const collections = useCollections();
  const cards = useCards();
  const [addOpen, setAddOpen] = useState(false);

  const byGroup = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const card of cards ?? []) {
      if (!card.groupId) continue;
      const list = map.get(card.groupId);
      if (list) list.push(card);
      else map.set(card.groupId, [card]);
    }
    return map;
  }, [cards]);

  if (!collections || !cards) return <Spinner />;

  const unassigned = cards.filter((c) => !c.groupId).length;

  return (
    <>
      <PageHeader
        title="團體"
        subtitle={collections.groups.length ? `${collections.groups.length} 個團體` : undefined}
        actions={
          <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
            <IconPlus className="h-4 w-4" />
            新增團體
          </button>
        }
      />

      {collections.groups.length === 0 ? (
        <EmptyState
          icon={<IconUsers />}
          title="還沒有建立團體"
          hint="建立團體後就能依團體 → 成員層層瀏覽收藏，也能用來建立全員套卡。"
          action={
            <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
              <IconPlus className="h-4 w-4" />
              新增團體
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {collections.groups.map((group) => {
            const groupCards = byGroup.get(group.id) ?? [];
            const memberCount = collections.members.filter((m) => m.groupId === group.id).length;
            return (
              <Link key={group.id} to={`/groups/${group.id}`} className="group block">
                <Cover photoId={coverPhotoId(groupCards)} alt={group.name} />
                <p className="mt-1.5 truncate font-medium">{group.name}</p>
                <p className="text-xs text-muted">
                  {groupCards.length} 張 · {memberCount} 位成員
                </p>
              </Link>
            );
          })}
        </div>
      )}

      {unassigned > 0 && (
        <p className="mt-6 text-sm text-muted">
          還有 {unassigned} 張小卡沒有指定團體。
          <Link to="/" className="ml-1 text-accent hover:underline">
            回卡片牆查看
          </Link>
        </p>
      )}

      <NewNameModal
        open={addOpen}
        title="新增團體"
        placeholder="例如：IVE"
        onClose={() => setAddOpen(false)}
        onSubmit={async (name) => {
          await repo.groups.ensure(name);
        }}
      />
    </>
  );
}
