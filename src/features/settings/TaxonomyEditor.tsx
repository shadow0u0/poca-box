import { useState } from 'react';
import { IconPencil, IconPlus, IconTrash } from '../../components/icons';
import { Modal } from '../../components/ui';
import { repo, type CardRefField } from '../../data/repo';

interface Row {
  id: string;
  name: string;
}

/**
 * One editable classification list. Shared by 來源 / 卡種 / 持有狀態 / 團體 /
 * 專輯 — they differ only in which card field points at them.
 *
 * Deleting checks for cards still using the row first and makes the user say
 * where those cards should go, so no card is left holding a dangling id.
 */
export function TaxonomyEditor({
  title,
  hint,
  rows,
  field,
  placeholder,
  onCreate,
  onRename,
  onRemove,
}: {
  title: string;
  hint?: string;
  rows: Row[];
  field: CardRefField;
  placeholder: string;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [editValue, setEditValue] = useState('');
  const [deleting, setDeleting] = useState<{ row: Row; inUse: number } | null>(null);
  const [reassignTo, setReassignTo] = useState<string>('');

  const create = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await onCreate(name);
      setNewName('');
    } finally {
      setBusy(false);
    }
  };

  const startDelete = async (row: Row) => {
    const inUse = await repo.cards.countUsing(field, row.id);
    setReassignTo('');
    setDeleting({ row, inUse });
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      if (deleting.inUse > 0) {
        await repo.cards.reassign(field, deleting.row.id, reassignTo || undefined);
      }
      await onRemove(deleting.row.id);
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card-surface p-4">
      <h2 className="font-medium">{title}</h2>
      {hint && <p className="mt-0.5 mb-3 text-xs text-muted">{hint}</p>}

      <ul className="mb-3 flex flex-col divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
            <button
              type="button"
              aria-label={`重新命名 ${row.name}`}
              className="btn-ghost btn-sm text-muted"
              onClick={() => {
                setEditing(row);
                setEditValue(row.name);
              }}
            >
              <IconPencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label={`刪除 ${row.name}`}
              className="btn-ghost btn-sm text-muted"
              onClick={() => void startDelete(row)}
            >
              <IconTrash className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="py-2 text-sm text-muted">還沒有任何項目</li>}
      </ul>

      <div className="flex gap-2">
        <input
          className="field"
          placeholder={placeholder}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void create();
            }
          }}
        />
        <button
          type="button"
          className="btn-outline shrink-0"
          disabled={!newName.trim() || busy}
          onClick={() => void create()}
        >
          <IconPlus className="h-4 w-4" />
          新增
        </button>
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`重新命名${title}`}
        footer={
          <>
            <button type="button" className="btn-outline" onClick={() => setEditing(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!editValue.trim()}
              onClick={async () => {
                if (editing) await onRename(editing.id, editValue);
                setEditing(null);
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
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
        />
      </Modal>

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`刪除「${deleting?.row.name ?? ''}」`}
        footer={
          <>
            <button type="button" className="btn-outline" onClick={() => setDeleting(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              刪除
            </button>
          </>
        }
      >
        {deleting && deleting.inUse > 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              目前有 <strong>{deleting.inUse}</strong> 張小卡使用「{deleting.row.name}」。
              請選擇這些小卡之後要改成什麼：
            </p>
            <select
              className="field"
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
            >
              <option value="">清空這個欄位</option>
              {rows
                .filter((r) => r.id !== deleting.row.id)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    改為「{r.name}」
                  </option>
                ))}
            </select>
          </div>
        ) : (
          <p className="text-sm text-muted">沒有小卡使用這個項目，可以安全刪除。</p>
        )}
      </Modal>
    </section>
  );
}
