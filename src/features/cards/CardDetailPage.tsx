import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AddToFolderModal } from '../../components/AddToFolderModal';
import { IconFlip, IconFolder, IconImage, IconPencil, IconTrash } from '../../components/icons';
import { ConfirmDialog, PageHeader, Spinner } from '../../components/ui';
import { useCard, useCollections, useNameLookup } from '../../data/hooks';
import { invalidatePhotoUrl, usePhotoUrl } from '../../data/photos';
import { repo } from '../../data/repo';
import { formatDate, formatPrice } from '../../lib/format';

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 border-b border-border py-2.5 last:border-b-0">
      <span className="w-24 shrink-0 text-sm text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-sm">{children}</span>
    </div>
  );
}

/** The card itself: tap to turn it over, when a back photo exists. */
function FlipCard({
  frontPhotoId,
  backPhotoId,
  name,
}: {
  frontPhotoId?: string;
  backPhotoId?: string;
  name: string;
}) {
  const [flipped, setFlipped] = useState(false);
  const front = usePhotoUrl(frontPhotoId, 'full');
  const back = usePhotoUrl(backPhotoId, 'full');
  const canFlip = !!backPhotoId;

  return (
    <div>
      <div className="flip-scene aspect-photocard w-full">
        <div className={`flip-inner ${flipped ? 'is-flipped' : ''}`}>
          <div className="flip-face bg-surface-2">
            {front ? (
              <img src={front} alt={`${name} 正面`} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-muted">
                <IconImage className="h-8 w-8" />
              </div>
            )}
          </div>
          <div className="flip-face flip-face-back bg-surface-2">
            {back ? (
              <img src={back} alt={`${name} 背面`} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted">
                沒有背面照片
              </div>
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="btn-outline mt-2 w-full"
        disabled={!canFlip}
        onClick={() => setFlipped((f) => !f)}
      >
        <IconFlip className="h-4 w-4" />
        {canFlip ? (flipped ? '看正面' : '看背面') : '未上傳背面'}
      </button>
    </div>
  );
}

export default function CardDetailPage() {
  const { cardId } = useParams();
  const navigate = useNavigate();
  const card = useCard(cardId);
  const collections = useCollections();
  const names = useNameLookup(collections);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [folderModalOpen, setFolderModalOpen] = useState(false);

  if (card === undefined || !collections) return <Spinner />;
  if (card === null) {
    return (
      <>
        <PageHeader title="找不到這張小卡" back="/" />
        <p className="text-sm text-muted">它可能已經被刪除了。</p>
      </>
    );
  }

  const memberNames = card.memberIds.map((id) => names.member.get(id)).filter(Boolean);
  const folderNames = card.folderIds
    .map((id) => ({ id, name: names.folder.get(id) }))
    .filter((f): f is { id: string; name: string } => !!f.name);
  const setName = card.setId ? names.set.get(card.setId) : undefined;

  const remove = async () => {
    await repo.cards.remove(card.id);
    // The photos are only unreferenced once the card is gone.
    for (const photoId of [card.frontPhotoId, card.backPhotoId]) {
      if (photoId) {
        invalidatePhotoUrl(photoId);
        await repo.photos.removeIfOrphaned(photoId);
      }
    }
    navigate('/', { replace: true });
  };

  return (
    <>
      <PageHeader
        title={card.name}
        back
        actions={
          <>
            <Link to={`/cards/${card.id}/edit`} className="btn-outline">
              <IconPencil className="h-4 w-4" />
              編輯
            </Link>
            <button
              type="button"
              aria-label="刪除"
              className="btn-danger"
              onClick={() => setConfirmOpen(true)}
            >
              <IconTrash className="h-4 w-4" />
            </button>
          </>
        }
      />

      <div className="grid gap-6 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <FlipCard
          frontPhotoId={card.frontPhotoId}
          backPhotoId={card.backPhotoId}
          name={card.name}
        />

        <div className="card-surface px-4 py-1">
          <DetailRow label="收藏時間">{formatDate(card.acquiredAt)}</DetailRow>
          <DetailRow label="來源">
            {card.sourceId ? (names.source.get(card.sourceId) ?? '—') : '—'}
          </DetailRow>
          <DetailRow label="團體">
            {card.groupId ? (
              <Link to={`/groups/${card.groupId}`} className="text-accent hover:underline">
                {names.group.get(card.groupId) ?? '—'}
              </Link>
            ) : (
              '—'
            )}
          </DetailRow>
          <DetailRow label="成員">
            {memberNames.length ? (
              <span className="flex flex-wrap gap-1.5">
                {card.memberIds.map((id) =>
                  names.member.get(id) ? (
                    <Link key={id} to={`/members/${id}`} className="chip hover:border-accent">
                      {names.member.get(id)}
                    </Link>
                  ) : null,
                )}
              </span>
            ) : (
              '—'
            )}
          </DetailRow>
          <DetailRow label="專輯／活動">
            {card.albumId ? (names.album.get(card.albumId) ?? '—') : '—'}
          </DetailRow>
          <DetailRow label="卡種">
            {card.cardTypeId ? (names.cardType.get(card.cardTypeId) ?? '—') : '—'}
          </DetailRow>
          <DetailRow label="持有狀態">
            {card.statusId ? (names.status.get(card.statusId) ?? '—') : '—'}
          </DetailRow>
          <DetailRow label="取得價格">{formatPrice(card.price, card.currency)}</DetailRow>
          <DetailRow label="所屬套卡">
            {setName && card.setId ? (
              <Link to={`/sets/${card.setId}`} className="text-accent hover:underline">
                {setName}
              </Link>
            ) : (
              '—'
            )}
          </DetailRow>
          <DetailRow label="收藏夾">
            <span className="flex flex-wrap items-center gap-1.5">
              {folderNames.map((f) => (
                <Link key={f.id} to={`/folders/${f.id}`} className="chip hover:border-accent">
                  {f.name}
                </Link>
              ))}
              <button
                type="button"
                className="btn-ghost btn-sm text-accent"
                onClick={() => setFolderModalOpen(true)}
              >
                <IconFolder className="h-3.5 w-3.5" />
                管理
              </button>
            </span>
          </DetailRow>
          {card.note && (
            <DetailRow label="備註">
              <span className="whitespace-pre-wrap">{card.note}</span>
            </DetailRow>
          )}
        </div>
      </div>

      <AddToFolderModal
        open={folderModalOpen}
        onClose={() => setFolderModalOpen(false)}
        cardIds={[card.id]}
        folders={collections.folders}
        activeFolderIds={new Set(card.folderIds)}
      />

      <ConfirmDialog
        open={confirmOpen}
        title="刪除這張小卡？"
        message={`「${card.name}」與它的照片都會被移除。`}
        confirmLabel="刪除"
        destructive
        onConfirm={() => void remove()}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
