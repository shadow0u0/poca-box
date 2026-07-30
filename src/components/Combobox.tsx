import { useMemo, useState } from 'react';
import { IconCheck, IconPlus, IconSearch, IconX } from './icons';
import { Modal } from './ui';
import { nameKey } from '../lib/id';

export interface Option {
  id: string;
  label: string;
  hint?: string;
}

/**
 * Picker that can also create what you typed.
 *
 * This is where "我可以自己新增來源的類別" actually lives: any classification
 * field accepts a name that doesn't exist yet and creates it on the spot, so
 * cataloguing never stalls on a trip to 設定.
 */
function useFiltered(options: Option[], query: string) {
  return useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLocaleLowerCase().includes(q));
  }, [options, query]);
}

function CreateRow({ name, onCreate }: { name: string; onCreate: () => void }) {
  return (
    <button type="button" className="btn-ghost w-full justify-start text-accent" onClick={onCreate}>
      <IconPlus className="h-4 w-4" />
      新增「{name}」
    </button>
  );
}

export function Combobox({
  label,
  value,
  options,
  placeholder = '未選擇',
  emptyLabel = '不指定',
  onChange,
  onCreate,
  disabled,
}: {
  label: string;
  value: string | undefined;
  options: Option[];
  placeholder?: string;
  emptyLabel?: string;
  onChange: (id: string | undefined) => void;
  /** Omit to make the field selection-only. Returns the new row's id. */
  onCreate?: (name: string) => Promise<string>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = useFiltered(options, query);
  const selected = options.find((o) => o.id === value);
  const trimmed = query.trim();
  const canCreate =
    !!onCreate && trimmed.length > 0 && !options.some((o) => nameKey(o.label) === nameKey(trimmed));

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const create = async () => {
    if (!onCreate || busy) return;
    setBusy(true);
    try {
      onChange(await onCreate(trimmed));
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <span className="label">{label}</span>
      {/* The clear control is a sibling, not a child — a button inside a button
          is invalid markup and unreachable for screen readers. */}
      <div className="relative">
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="field flex items-center justify-between gap-2 pr-9 text-left disabled:opacity-50"
        >
          <span className={selected ? 'truncate' : 'truncate text-muted'}>
            {selected?.label ?? placeholder}
          </span>
        </button>
        {selected && !disabled && (
          <button
            type="button"
            aria-label={`清除${label}`}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted hover:text-text"
            onClick={() => onChange(undefined)}
          >
            <IconX className="h-4 w-4" />
          </button>
        )}
      </div>

      <Modal open={open} onClose={close} title={label}>
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-border px-3">
          <IconSearch className="h-4 w-4 shrink-0 text-muted" />
          <input
            autoFocus
            className="w-full bg-transparent py-2 text-sm outline-none"
            placeholder={onCreate ? '搜尋，或輸入新名稱' : '搜尋'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate) {
                e.preventDefault();
                void create();
              }
            }}
          />
        </div>

        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            className="btn-ghost w-full justify-between"
            onClick={() => {
              onChange(undefined);
              close();
            }}
          >
            <span className="text-muted">{emptyLabel}</span>
            {!value && <IconCheck className="h-4 w-4 text-accent" />}
          </button>

          {filtered.map((option) => (
            <button
              key={option.id}
              type="button"
              className="btn-ghost w-full justify-between"
              onClick={() => {
                onChange(option.id);
                close();
              }}
            >
              <span className="min-w-0 truncate text-left">
                {option.label}
                {option.hint && <span className="ml-2 text-xs text-muted">{option.hint}</span>}
              </span>
              {value === option.id && <IconCheck className="h-4 w-4 shrink-0 text-accent" />}
            </button>
          ))}

          {canCreate && <CreateRow name={trimmed} onCreate={() => void create()} />}

          {filtered.length === 0 && !canCreate && (
            <p className="py-6 text-center text-sm text-muted">找不到符合的項目</p>
          )}
        </div>
      </Modal>
    </div>
  );
}

export function MultiCombobox({
  label,
  values,
  options,
  placeholder = '未選擇',
  onChange,
  onCreate,
  disabled,
  disabledHint,
}: {
  label: string;
  values: string[];
  options: Option[];
  placeholder?: string;
  onChange: (ids: string[]) => void;
  onCreate?: (name: string) => Promise<string>;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = useFiltered(options, query);
  const selected = options.filter((o) => values.includes(o.id));
  const trimmed = query.trim();
  const canCreate =
    !!onCreate && trimmed.length > 0 && !options.some((o) => nameKey(o.label) === nameKey(trimmed));

  const toggle = (id: string) =>
    onChange(values.includes(id) ? values.filter((v) => v !== id) : [...values, id]);

  const create = async () => {
    if (!onCreate || busy) return;
    setBusy(true);
    try {
      const id = await onCreate(trimmed);
      onChange([...values, id]);
      setQuery('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <span className="label">{label}</span>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="field flex min-h-[42px] flex-wrap items-center gap-1.5 text-left disabled:opacity-50"
      >
        {selected.length === 0 ? (
          <span className="text-muted">{disabled && disabledHint ? disabledHint : placeholder}</span>
        ) : (
          selected.map((o) => (
            <span key={o.id} className="chip chip-active">
              {o.label}
            </span>
          ))
        )}
      </button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        title={label}
        footer={
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setOpen(false);
              setQuery('');
            }}
          >
            完成
          </button>
        }
      >
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-border px-3">
          <IconSearch className="h-4 w-4 shrink-0 text-muted" />
          <input
            autoFocus
            className="w-full bg-transparent py-2 text-sm outline-none"
            placeholder={onCreate ? '搜尋，或輸入新名稱' : '搜尋'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate) {
                e.preventDefault();
                void create();
              }
            }}
          />
        </div>

        <div className="flex flex-col gap-0.5">
          {filtered.map((option) => (
            <button
              key={option.id}
              type="button"
              className="btn-ghost w-full justify-between"
              onClick={() => toggle(option.id)}
            >
              <span className="min-w-0 truncate text-left">{option.label}</span>
              {values.includes(option.id) && <IconCheck className="h-4 w-4 shrink-0 text-accent" />}
            </button>
          ))}

          {canCreate && <CreateRow name={trimmed} onCreate={() => void create()} />}

          {filtered.length === 0 && !canCreate && (
            <p className="py-6 text-center text-sm text-muted">找不到符合的項目</p>
          )}
        </div>
      </Modal>
    </div>
  );
}
