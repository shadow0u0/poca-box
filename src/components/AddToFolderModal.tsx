import { useState } from 'react';
import { repo } from '../data/repo';
import type { Folder } from '../data/types';
import { IconCheck, IconPlus } from './icons';
import { Modal } from './ui';

/** Add or remove a batch of cards from 收藏夾, with inline folder creation. */
export function AddToFolderModal({
  open,
  onClose,
  cardIds,
  folders,
  /** Folders already on every selected card, shown as ticked. */
  activeFolderIds,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  cardIds: string[];
  folders: Folder[];
  activeFolderIds: Set<string>;
  onDone?: () => void;
}) {
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = async (folderId: string, add: boolean) => {
    setBusy(true);
    try {
      await repo.cards.setFolders(cardIds, folderId, add);
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const folder = await repo.folders.ensure(name);
      await repo.cards.setFolders(cardIds, folder.id, true);
      setNewName('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={cardIds.length > 1 ? `加入收藏夾（${cardIds.length} 張）` : '加入收藏夾'}
      footer={
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            onDone?.();
            onClose();
          }}
        >
          完成
        </button>
      }
    >
      <div className="flex flex-col gap-0.5">
        {folders.map((folder) => {
          const active = activeFolderIds.has(folder.id);
          return (
            <button
              key={folder.id}
              type="button"
              disabled={busy}
              className="btn-ghost w-full justify-between"
              onClick={() => void toggle(folder.id, !active)}
            >
              <span className="truncate">{folder.name}</span>
              {active && <IconCheck className="h-4 w-4 shrink-0 text-accent" />}
            </button>
          );
        })}
        {folders.length === 0 && (
          <p className="py-4 text-center text-sm text-muted">還沒有收藏夾，在下面建一個吧</p>
        )}
      </div>

      <div className="mt-4 flex gap-2 border-t border-border pt-4">
        <input
          className="field"
          placeholder="新收藏夾名稱"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void createAndAdd();
            }
          }}
        />
        <button
          type="button"
          className="btn-outline shrink-0"
          disabled={!newName.trim() || busy}
          onClick={() => void createAndAdd()}
        >
          <IconPlus className="h-4 w-4" />
          建立
        </button>
      </div>
    </Modal>
  );
}
