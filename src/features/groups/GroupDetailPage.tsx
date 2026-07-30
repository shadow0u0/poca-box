import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { IconImage, IconPlus } from '../../components/icons';
import { EmptyState, PageHeader, Spinner } from '../../components/ui';
import { useCards, useCollections } from '../../data/hooks';
import { usePhotoUrl } from '../../data/photos';
import { repo } from '../../data/repo';
import type { Card } from '../../data/types';
import { NewNameModal, coverPhotoId } from './GroupsPage';

function MemberCover({ photoId, alt }: { photoId?: string; alt: string }) {
  const url = usePhotoUrl(photoId, 'thumb');
  return (
    <div className="aspect-square overflow-hidden rounded-full bg-surface-2">
      {url ? (
        <img src={url} alt={alt} loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center text-muted">
          <IconImage className="h-5 w-5" />
        </div>
      )}
    </div>
  );
}

export default function GroupDetailPage() {
  const { groupId } = useParams();
  const collections = useCollections();
  const cards = useCards();
  const [addOpen, setAddOpen] = useState(false);

  const group = collections?.groups.find((g) => g.id === groupId);
  const members = useMemo(
    () => (collections?.members ?? []).filter((m) => m.groupId === groupId),
    [collections, groupId],
  );

  const groupCards = useMemo(
    () => (cards ?? []).filter((c) => c.groupId === groupId),
    [cards, groupId],
  );

  const byMember = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const card of groupCards) {
      for (const memberId of card.memberIds) {
        const list = map.get(memberId);
        if (list) list.push(card);
        else map.set(memberId, [card]);
      }
    }
    return map;
  }, [groupCards]);

  if (!collections || !cards) return <Spinner />;
  if (!group) {
    return (
      <>
        <PageHeader title="找不到這個團體" back="/groups" />
        <p className="text-sm text-muted">它可能已經被刪除了。</p>
      </>
    );
  }

  const noMemberCount = groupCards.filter((c) => c.memberIds.length === 0).length;

  return (
    <>
      <PageHeader
        title={group.name}
        subtitle={`${groupCards.length} 張小卡 · ${members.length} 位成員`}
        back="/groups"
        actions={
          <button type="button" className="btn-outline" onClick={() => setAddOpen(true)}>
            <IconPlus className="h-4 w-4" />
            新增成員
          </button>
        }
      />

      {members.length === 0 ? (
        <EmptyState
          title="還沒有成員"
          hint="加入成員後，就能看到每位成員各自的小卡，也能建立全員套卡。"
          action={
            <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
              <IconPlus className="h-4 w-4" />
              新增成員
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {members.map((member) => {
            const memberCards = byMember.get(member.id) ?? [];
            return (
              <Link key={member.id} to={`/members/${member.id}`} className="block text-center">
                <MemberCover photoId={coverPhotoId(memberCards)} alt={member.name} />
                <p className="mt-1.5 truncate text-sm font-medium">{member.name}</p>
                <p className="text-xs text-muted">{memberCards.length} 張</p>
              </Link>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <Link to={`/?group=${group.id}`} className="btn-outline">
          查看此團體全部 {groupCards.length} 張小卡
        </Link>
        {noMemberCount > 0 && (
          <span className="btn-ghost text-muted">其中 {noMemberCount} 張未標註成員</span>
        )}
      </div>

      <NewNameModal
        open={addOpen}
        title={`為 ${group.name} 新增成員`}
        placeholder="例如：張員瑛"
        onClose={() => setAddOpen(false)}
        onSubmit={async (name) => {
          await repo.members.ensureInGroup(group.id, name);
        }}
      />
    </>
  );
}
