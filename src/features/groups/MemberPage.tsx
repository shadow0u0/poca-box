import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { VirtualCardGrid } from '../../components/VirtualCardGrid';
import { IconPlus } from '../../components/icons';
import { EmptyState, PageHeader, Spinner } from '../../components/ui';
import { useCards, useCollections, useNameLookup } from '../../data/hooks';

export default function MemberPage() {
  const { memberId } = useParams();
  const collections = useCollections();
  const cards = useCards();
  const names = useNameLookup(collections);

  const member = collections?.members.find((m) => m.id === memberId);
  const memberCards = useMemo(
    () => (cards ?? []).filter((c) => memberId && c.memberIds.includes(memberId)),
    [cards, memberId],
  );

  if (!collections || !cards) return <Spinner />;
  if (!member) {
    return (
      <>
        <PageHeader title="找不到這位成員" back="/groups" />
        <p className="text-sm text-muted">她／他可能已經被刪除了。</p>
      </>
    );
  }

  const groupName = names.group.get(member.groupId);

  return (
    <>
      <PageHeader
        title={member.name}
        subtitle={`${groupName ?? ''} · ${memberCards.length} 張小卡`}
        back={`/groups/${member.groupId}`}
        actions={
          <Link
            to={`/cards/new?group=${member.groupId}&member=${member.id}`}
            className="btn-primary"
          >
            <IconPlus className="h-4 w-4" />
            新增
          </Link>
        }
      />

      {memberCards.length === 0 ? (
        <EmptyState
          title={`還沒有 ${member.name} 的小卡`}
          hint="新增小卡時選擇這位成員，就會出現在這裡。"
          action={
            <Link
              to={`/cards/new?group=${member.groupId}&member=${member.id}`}
              className="btn-primary"
            >
              <IconPlus className="h-4 w-4" />
              新增小卡
            </Link>
          }
        />
      ) : (
        <VirtualCardGrid
          cards={memberCards}
          subtitleFor={(card) =>
            card.albumId ? names.album.get(card.albumId) : undefined
          }
        />
      )}
    </>
  );
}
