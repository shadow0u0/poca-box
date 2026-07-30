import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconFolder, IconImage, IconPencil, IconPlus, IconTrash } from '../../components/icons';
import { ConfirmDialog, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui';
import { useCards, useCollections } from '../../data/hooks';
import { usePhotoUrl } from '../../data/photos';
import { repo } from '../../data/repo';
import type { Card, Folder } from '../../data/types';
import { NewNameModal, coverPhotoId } from '../groups/GroupsPage';

function FolderCover({ photoId, alt }: { photoId?: string; alt: string }) {
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

export default function FoldersPage() {
  const collections = useCollections();
  const cards = useCards();
  const [addOpen, setAddOpen] = useState(false);
  const [renaming, setRenaming] = useState<Folder | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<Folder | null>(null);

  const byFolder = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const card of cards ?? []) {
      for (const folderId of card.folderIds) {
        const list = map.get(folderId);
        if (list) list.push(card);
        else map.set(folderId, [card]);
      }
    }
    return map;
  }, [cards]);

  if (!collections || !cards) return <Spinner />;

  const removeFolder = async (folder: Folder) => {
    // Drop the folder from every card first, so no card keeps a dangling id.
    await repo.cards.removeFolderEverywhere(folder.id);
    await repo.folders.remove(folder.id);
    setDeleting(null);
  };

  return (
    <>
      <PageHeader
        title="收藏夾"
        subtitle={collections.folders.length ? `${collections.folders.length} 個收藏夾` : undefined}
        actions={
          <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
            <IconPlus className="h-4 w-4" />
            新增
          </button>
        }
      />

      {collections.folders.length === 0 ? (
        <EmptyState
          icon={<IconFolder />}
          title="還沒有收藏夾"
          hint="自己建立分類，例如「最愛」「待交換」「願望清單」。一張小卡可以同時放進多個收藏夾。"
          action={
            <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
              <IconPlus className="h-4 w-4" />
              新增收藏夾
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {collections.folders.map((folder) => {
            const folderCards = byFolder.get(folder.id) ?? [];
            return (
              <div key={folder.id}>
                <Link to={`/folders/${folder.id}`} className="block">
                  <FolderCover photoId={coverPhotoId(folderCards)} alt={folder.name} />
                  <p className="mt-1.5 truncate font-medium">{folder.name}</p>
                  <p className="text-xs text-muted">{folderCards.length} 張</p>
                </Link>
                <div className="mt-1 flex gap-1">
                  <button
                    type="button"
                    aria-label={`重新命名 ${folder.name}`}
                    className="btn-ghost btn-sm text-muted"
                    onClick={() => {
                      setRenaming(folder);
                      setRenameValue(folder.name);
                    }}
                  >
                    <IconPencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`刪除 ${folder.name}`}
                    className="btn-ghost btn-sm text-muted"
                    onClick={() => setDeleting(folder)}
                  >
                    <IconTrash className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <NewNameModal
        open={addOpen}
        title="新增收藏夾"
        placeholder="例如：待交換"
        onClose={() => setAddOpen(false)}
        onSubmit={async (name) => {
          await repo.folders.ensure(name);
        }}
      />

      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="重新命名收藏夾"
        footer={
          <>
            <button type="button" className="btn-outline" onClick={() => setRenaming(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!renameValue.trim()}
              onClick={async () => {
                if (renaming) await repo.folders.rename(renaming.id, renameValue);
                setRenaming(null);
              }}
            >
              儲存
            </button>
          </>
        }
      >
        <input
          autoFocus
          className="field"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
        />
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        title="刪除收藏夾？"
        message={
          deleting
            ? `「${deleting.name}」會被移除，裡面的 ${
                (byFolder.get(deleting.id) ?? []).length
              } 張小卡本身不會被刪除。`
            : ''
        }
        confirmLabel="刪除"
        destructive
        onConfirm={() => deleting && void removeFolder(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
