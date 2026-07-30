import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { VirtualCardGrid } from '../../components/VirtualCardGrid';
import { IconPlus } from '../../components/icons';
import { EmptyState, PageHeader, Spinner } from '../../components/ui';
import { useCards, useCollections, useNameLookup } from '../../data/hooks';

export default function FolderDetailPage() {
  const { folderId } = useParams();
  const collections = useCollections();
  const cards = useCards();
  const names = useNameLookup(collections);

  const folder = collections?.folders.find((f) => f.id === folderId);
  const folderCards = useMemo(
    () => (cards ?? []).filter((c) => folderId && c.folderIds.includes(folderId)),
    [cards, folderId],
  );

  if (!collections || !cards) return <Spinner />;
  if (!folder) {
    return (
      <>
        <PageHeader title="找不到這個收藏夾" back="/folders" />
        <p className="text-sm text-muted">它可能已經被刪除了。</p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={folder.name}
        subtitle={`${folderCards.length} 張小卡`}
        back="/folders"
        actions={
          <Link to={`/cards/new?folder=${folder.id}`} className="btn-primary">
            <IconPlus className="h-4 w-4" />
            新增
          </Link>
        }
      />

      {folderCards.length === 0 ? (
        <EmptyState
          title="這個收藏夾還是空的"
          hint="到卡片牆點「多選」，挑幾張加進來；或在小卡詳情頁的收藏夾欄位加入。"
          action={
            <Link to="/" className="btn-outline">
              前往卡片牆
            </Link>
          }
        />
      ) : (
        <VirtualCardGrid
          cards={folderCards}
          subtitleFor={(card) => {
            const group = card.groupId ? names.group.get(card.groupId) : undefined;
            const member = card.memberIds
              .map((m) => names.member.get(m))
              .filter(Boolean)
              .join('、');
            return [group, member].filter(Boolean).join(' · ') || undefined;
          }}
        />
      )}
    </>
  );
}
