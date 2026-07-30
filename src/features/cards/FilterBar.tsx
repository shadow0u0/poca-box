import { useMemo, useState } from 'react';
import { IconSearch, IconX } from '../../components/icons';
import { Modal } from '../../components/ui';
import type { Collections } from '../../data/hooks';
import {
  EMPTY_FILTER,
  SORT_OPTIONS,
  countActiveFacets,
  type CardFilter,
} from './filters';

interface FacetProps {
  title: string;
  options: { id: string; label: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

function Facet({ title, options, selected, onChange }: FacetProps) {
  if (options.length === 0) return null;
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    <div>
      <p className="label">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={selected.includes(o.id)}
            className={selected.includes(o.id) ? 'chip chip-active' : 'chip'}
            onClick={() => toggle(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function FilterBar({
  filter,
  collections,
  onChange,
}: {
  filter: CardFilter;
  collections: Collections;
  onChange: (next: CardFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = countActiveFacets(filter);

  const set = <K extends keyof CardFilter>(key: K, value: CardFilter[K]) =>
    onChange({ ...filter, [key]: value });

  // Narrow the member list to the chosen groups, so picking IVE doesn't leave
  // fifty unrelated member chips on screen.
  const memberOptions = useMemo(() => {
    const inScope = filter.groupIds.length
      ? collections.members.filter((m) => filter.groupIds.includes(m.groupId))
      : collections.members;
    const groupName = new Map(collections.groups.map((g) => [g.id, g.name]));
    return inScope.map((m) => ({
      id: m.id,
      label: filter.groupIds.length === 1 ? m.name : `${groupName.get(m.groupId) ?? ''} ${m.name}`.trim(),
    }));
  }, [collections.members, collections.groups, filter.groupIds]);

  const toOptions = (rows: { id: string; name: string }[]) =>
    rows.map((r) => ({ id: r.id, label: r.name }));

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex min-w-[180px] flex-1 items-center gap-2 rounded-xl border border-border bg-surface px-3">
        <IconSearch className="h-4 w-4 shrink-0 text-muted" />
        <input
          className="w-full bg-transparent py-2 text-sm outline-none"
          placeholder="搜尋名稱或備註"
          value={filter.q}
          onChange={(e) => set('q', e.target.value)}
        />
        {filter.q && (
          <button type="button" aria-label="清除搜尋" onClick={() => set('q', '')}>
            <IconX className="h-4 w-4 text-muted" />
          </button>
        )}
      </div>

      <select
        className="field w-auto"
        value={filter.sort}
        onChange={(e) => set('sort', e.target.value as CardFilter['sort'])}
        aria-label="排序方式"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>

      <button type="button" className="btn-outline" onClick={() => setOpen(true)}>
        篩選
        {activeCount > 0 && (
          <span className="ml-1 rounded-full bg-accent px-1.5 text-xs text-on-accent">
            {activeCount}
          </span>
        )}
      </button>

      {activeCount > 0 && (
        <button
          type="button"
          className="btn-ghost text-muted"
          onClick={() => onChange({ ...EMPTY_FILTER, q: filter.q, sort: filter.sort })}
        >
          清除
        </button>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="篩選條件"
        wide
        footer={
          <>
            <button
              type="button"
              className="btn-outline"
              onClick={() => onChange({ ...EMPTY_FILTER, q: filter.q, sort: filter.sort })}
            >
              全部清除
            </button>
            <button type="button" className="btn-primary" onClick={() => setOpen(false)}>
              查看結果
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Facet
            title="團體"
            options={toOptions(collections.groups)}
            selected={filter.groupIds}
            onChange={(ids) => {
              // Drop member selections that the new group scope no longer covers.
              const allowed = new Set(
                collections.members.filter((m) => !ids.length || ids.includes(m.groupId)).map((m) => m.id),
              );
              onChange({
                ...filter,
                groupIds: ids,
                memberIds: filter.memberIds.filter((m) => allowed.has(m)),
              });
            }}
          />
          <Facet
            title="成員"
            options={memberOptions}
            selected={filter.memberIds}
            onChange={(ids) => set('memberIds', ids)}
          />
          <Facet
            title="來源"
            options={toOptions(collections.sources)}
            selected={filter.sourceIds}
            onChange={(ids) => set('sourceIds', ids)}
          />
          <Facet
            title="卡種"
            options={toOptions(collections.cardTypes)}
            selected={filter.cardTypeIds}
            onChange={(ids) => set('cardTypeIds', ids)}
          />
          <Facet
            title="持有狀態"
            options={toOptions(collections.statuses)}
            selected={filter.statusIds}
            onChange={(ids) => set('statusIds', ids)}
          />
          <Facet
            title="專輯／活動"
            options={toOptions(collections.albums)}
            selected={filter.albumIds}
            onChange={(ids) => set('albumIds', ids)}
          />
          <Facet
            title="收藏夾"
            options={toOptions(collections.folders)}
            selected={filter.folderIds}
            onChange={(ids) => set('folderIds', ids)}
          />

          <div>
            <p className="label">收藏時間</p>
            <div className="flex items-center gap-2">
              <input
                type="date"
                className="field"
                value={filter.from}
                max={filter.to || undefined}
                onChange={(e) => set('from', e.target.value)}
                aria-label="起始日期"
              />
              <span className="text-muted">—</span>
              <input
                type="date"
                className="field"
                value={filter.to}
                min={filter.from || undefined}
                onChange={(e) => set('to', e.target.value)}
                aria-label="結束日期"
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
