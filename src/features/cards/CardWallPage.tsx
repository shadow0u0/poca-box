import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AddToFolderModal } from '../../components/AddToFolderModal';
import { VirtualCardGrid } from '../../components/VirtualCardGrid';
import { IconCards, IconFolder, IconPlus } from '../../components/icons';
import { EmptyState, PageHeader, Spinner } from '../../components/ui';
import { useCards, useCollections, useNameLookup } from '../../data/hooks';
import { FilterBar } from './FilterBar';
import { applyFilter, parseFilter, serializeFilter } from './filters';

export default function CardWallPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const cards = useCards();
  const collections = useCollections();
  const names = useNameLookup(collections);

  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [folderModalOpen, setFolderModalOpen] = useState(false);

  const filter = useMemo(() => parseFilter(searchParams), [searchParams]);
  const visible = useMemo(() => (cards ? applyFilter(cards, filter) : []), [cards, filter]);

  const subtitleFor = (cardId: { groupId?: string; memberIds: string[] }) => {
    const group = cardId.groupId ? names.group.get(cardId.groupId) : undefined;
    const member = cardId.memberIds.map((m) => names.member.get(m)).filter(Boolean).join('、');
    return [group, member].filter(Boolean).join(' · ') || undefined;
  };

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exitSelection = () => {
    setSelecting(false);
    setSelectedIds(new Set());
  };

  // A folder ticks only when every selected card is already in it.
  const sharedFolderIds = useMemo(() => {
    const chosen = (cards ?? []).filter((c) => selectedIds.has(c.id));
    if (chosen.length === 0) return new Set<string>();
    return new Set(
      chosen[0].folderIds.filter((f) => chosen.every((card) => card.folderIds.includes(f))),
    );
  }, [cards, selectedIds]);

  if (!cards || !collections) return <Spinner />;

  const hasAnyCards = cards.length > 0;

  return (
    <>
      <PageHeader
        title="我的小卡"
        subtitle={
          hasAnyCards
            ? `共 ${cards.length} 張${visible.length !== cards.length ? `，符合篩選 ${visible.length} 張` : ''}`
            : undefined
        }
        actions={
          hasAnyCards ? (
            selecting ? (
              <button type="button" className="btn-ghost" onClick={exitSelection}>
                取消
              </button>
            ) : (
              <>
                <button type="button" className="btn-outline" onClick={() => setSelecting(true)}>
                  多選
                </button>
                <Link to="/cards/new" className="btn-primary">
                  <IconPlus className="h-4 w-4" />
                  新增
                </Link>
              </>
            )
          ) : null
        }
      />

      {hasAnyCards && (
        <FilterBar
          filter={filter}
          collections={collections}
          onChange={(next) => setSearchParams(serializeFilter(next), { replace: true })}
        />
      )}

      {!hasAnyCards ? (
        <EmptyState
          icon={<IconCards />}
          title="還沒有任何小卡"
          hint="新增第一張小卡，記錄它的名稱、收藏時間與來源，並上傳正反面照片。"
          action={
            <Link to="/cards/new" className="btn-primary">
              <IconPlus className="h-4 w-4" />
              新增小卡
            </Link>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState title="沒有符合條件的小卡" hint="試著放寬或清除篩選條件。" />
      ) : (
        <VirtualCardGrid
          cards={visible}
          subtitleFor={subtitleFor}
          selectable={selecting}
          selectedIds={selectedIds}
          onToggle={toggle}
        />
      )}

      {/* Selection action bar sits above the phone tab bar. */}
      {selecting && selectedIds.size > 0 && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur md:bottom-0">
          <div className="mx-auto flex max-w-6xl items-center gap-3">
            <span className="text-sm text-muted">已選 {selectedIds.size} 張</span>
            <button
              type="button"
              className="btn-primary ml-auto"
              onClick={() => setFolderModalOpen(true)}
            >
              <IconFolder className="h-4 w-4" />
              加入收藏夾
            </button>
          </div>
        </div>
      )}

      <AddToFolderModal
        open={folderModalOpen}
        onClose={() => setFolderModalOpen(false)}
        cardIds={[...selectedIds]}
        folders={collections.folders}
        activeFolderIds={sharedFolderIds}
        onDone={exitSelection}
      />
    </>
  );
}
