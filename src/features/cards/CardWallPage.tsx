import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AddToFolderModal } from '../../components/AddToFolderModal';
import { VirtualCardGrid } from '../../components/VirtualCardGrid';
import { IconChart, IconFolder, IconPlus } from '../../components/icons';
import { EmptyState, PageHeader, Spinner } from '../../components/ui';
import { useCards, useCollections, useNameLookup } from '../../data/hooks';
import { FilterBar } from './FilterBar';
import { applyFilter, parseFilter, serializeFilter } from './filters';

/**
 * What someone opening 小卡櫃 for the first time sees.
 *
 * It used to be one sentence and an 新增小卡 button, which is fine for the
 * person who built the app and thin for a friend who was handed a link. The
 * three steps are the actual shape of getting started, and each one is a link
 * rather than an instruction to go and find something.
 */
function FirstRunGuide() {
  const steps = [
    {
      title: '先建立團體與成員',
      body: '之後新增小卡時就能直接選，卡片頁也能依團體、成員瀏覽。',
      to: '/groups',
      label: '去建立團體',
    },
    {
      title: '新增第一張小卡',
      body: '記下名稱、收藏時間與來源，並上傳正反面照片。照片會自動壓縮。',
      to: '/cards/new',
      label: '新增小卡',
    },
    {
      title: '想在手機和電腦都看到，就開啟同步',
      body: '需要邀請。沒開啟的話，資料就只留在這台裝置 —— 記得定期匯出備份。',
      to: '/settings',
      label: '去設定',
    },
  ];

  return (
    <div className="mx-auto max-w-lg py-8">
      <h2 className="text-center text-lg font-medium">歡迎使用小卡櫃</h2>
      <p className="mt-1 text-center text-sm text-muted">收藏還是空的。從這三步開始：</p>

      <ol className="mt-6 flex flex-col gap-3">
        {steps.map((step, i) => (
          <li key={step.to} className="card-surface flex gap-3 p-4">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-medium text-accent">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{step.title}</p>
              <p className="mt-0.5 text-xs text-muted">{step.body}</p>
              <Link to={step.to} className="btn-outline btn-sm mt-2.5">
                {step.label}
              </Link>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

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
                {/* Not a sixth tab: five already fill the phone bar. */}
                <Link to="/stats" className="btn-ghost" aria-label="收藏統計">
                  <IconChart className="h-4 w-4" />
                  <span className="hidden sm:inline">統計</span>
                </Link>
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
        <FirstRunGuide />
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
