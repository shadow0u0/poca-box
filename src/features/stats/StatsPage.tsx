import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Spinner } from '../../components/ui';
import { useCards, useCollections, type Collections } from '../../data/hooks';
import type { Card } from '../../data/types';
import { setProgress } from '../sets/SetsPage';

/**
 * 收藏統計 — everything worked out from the cards already in memory.
 *
 * No new storage, no sync, nothing to keep in step: the numbers are derived on
 * every render from the same live queries the rest of the app uses, so they
 * cannot fall out of date. The charts are hand-drawn divs and one inline SVG
 * rather than a charting library — the bundle already carries Firebase, and
 * what is drawn here is bars and a ring.
 */

interface Tally {
  id: string;
  name: string;
  count: number;
}

/** Count cards by a key, resolve the names, and put the biggest first. */
function tally(cards: Card[], key: (c: Card) => string | undefined, names: Map<string, string>): Tally[] {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const id = key(card);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, name: names.get(id) ?? '（已刪除）', count }))
    .sort((a, b) => b.count - a.count);
}

const nameMap = (rows: { id: string; name: string }[]) => new Map(rows.map((r) => [r.id, r.name]));

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-medium tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** A ranked list as bars. Widths are relative to the largest, not to the total,
 *  so a long tail stays readable instead of collapsing into slivers. */
function BarList({ rows, empty }: { rows: Tally[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  const max = rows[0].count;

  return (
    <ol className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.id}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{row.name}</span>
            <span className="shrink-0 tabular-nums text-muted">{row.count}</span>
          </div>
          <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${(row.count / max) * 100}%` }}
            />
          </span>
        </li>
      ))}
    </ol>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card-surface p-4">
      <h2 className="mb-3 font-medium">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Cards acquired per month, most recent twelve.
 *
 * Months with nothing in them are kept rather than skipped — a gap is part of
 * the shape of a collection, and dropping it would silently compress time.
 */
function Timeline({ cards }: { cards: Card[] }) {
  const months = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of cards) {
      const month = card.acquiredAt?.slice(0, 7);
      if (month && /^\d{4}-\d{2}$/.test(month)) counts.set(month, (counts.get(month) ?? 0) + 1);
    }
    if (counts.size === 0) return [];

    const sorted = [...counts.keys()].sort();
    const out: { month: string; count: number }[] = [];
    const [y, m] = sorted[sorted.length - 1].split('-').map(Number);
    const cursor = new Date(Date.UTC(y, m - 1, 1));
    for (let i = 0; i < 12; i += 1) {
      const key = cursor.toISOString().slice(0, 7);
      out.unshift({ month: key, count: counts.get(key) ?? 0 });
      cursor.setUTCMonth(cursor.getUTCMonth() - 1);
      if (key <= sorted[0]) break;
    }
    return out;
  }, [cards]);

  if (months.length === 0) return <p className="text-sm text-muted">還沒有收藏時間的紀錄。</p>;
  const max = Math.max(...months.map((m) => m.count));

  return (
    <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
      {months.map(({ month, count }) => (
        <div key={month} className="flex min-w-9 flex-1 flex-col items-center gap-1">
          <span className="text-xs tabular-nums text-muted">{count || ''}</span>
          <span
            className="w-full rounded-t bg-accent"
            style={{ height: `${Math.max(2, (count / max) * 72)}px`, opacity: count ? 1 : 0.25 }}
            title={`${month}：${count} 張`}
          />
          <span className="text-[10px] text-muted">{month.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

/** Completion of every 套卡, as a ring plus a count. */
function SetProgress({ cards, collections }: { cards: Card[]; collections: Collections }) {
  // Reuses the same derivation the 套卡 screens use, so the two can never
  // disagree about what "完成" means.
  const rows = collections.sets.map((set) => {
    const { filled, total } = setProgress(set, cards);
    return { id: set.id, name: set.name, owned: filled, total };
  });

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        還沒有套卡。<Link to="/sets" className="text-accent">去建立一組</Link>，就能追蹤蒐集進度。
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => {
        const pct = row.total > 0 ? Math.min(1, row.owned / row.total) : 0;
        const circumference = 2 * Math.PI * 16;
        return (
          <li key={row.id} className="flex items-center gap-3">
            <svg viewBox="0 0 40 40" className="h-10 w-10 shrink-0 -rotate-90" aria-hidden="true">
              <circle cx="20" cy="20" r="16" fill="none" strokeWidth="5" className="stroke-surface-2" />
              <circle
                cx="20"
                cy="20"
                r="16"
                fill="none"
                strokeWidth="5"
                strokeLinecap="round"
                className="stroke-accent"
                strokeDasharray={`${circumference * pct} ${circumference}`}
              />
            </svg>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{row.name}</p>
              <p className="text-xs text-muted tabular-nums">
                {row.owned} / {row.total} 張
                {row.total > 0 && ` · ${Math.round(pct * 100)}%`}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function StatsPage() {
  const cards = useCards();
  const collections = useCollections();

  const stats = useMemo(() => {
    if (!cards || !collections) return null;

    const withPhoto = cards.filter((c) => c.frontPhotoId || c.backPhotoId).length;
    const memberNames = nameMap(collections.members);

    return {
      total: cards.length,
      withPhoto,
      groups: tally(cards, (c) => c.groupId, nameMap(collections.groups)),
      // A card can name several members, so this counts appearances rather
      // than cards — the total will exceed the card count, which is right.
      members: [...cards.flatMap((c) => c.memberIds.map((id) => ({ card: c, id })))]
        .reduce<Tally[]>((acc, { id }) => {
          const hit = acc.find((r) => r.id === id);
          if (hit) hit.count += 1;
          else acc.push({ id, name: memberNames.get(id) ?? '（已刪除）', count: 1 });
          return acc;
        }, [])
        .sort((a, b) => b.count - a.count),
      sources: tally(cards, (c) => c.sourceId, nameMap(collections.sources)),
      cardTypes: tally(cards, (c) => c.cardTypeId, nameMap(collections.cardTypes)),
      statuses: tally(cards, (c) => c.statusId, nameMap(collections.statuses)),
    };
  }, [cards, collections]);

  if (!cards || !collections || !stats) return <Spinner />;

  if (stats.total === 0) {
    return (
      <>
        <PageHeader title="收藏統計" />
        <p className="mt-6 text-center text-sm text-muted">
          還沒有小卡，統計等第一張入櫃再說。
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader title="收藏統計" subtitle={`共 ${stats.total} 張`} />

      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="小卡張數" value={stats.total} />
          <Stat
            label="有照片的"
            value={stats.withPhoto}
            hint={`${Math.round((stats.withPhoto / stats.total) * 100)}%`}
          />
          <Stat label="團體" value={stats.groups.length} />
          <Stat label="成員" value={stats.members.length} />
        </div>

        <Section title="收藏時間">
          <Timeline cards={cards} />
        </Section>

        <div className="grid gap-4 md:grid-cols-2">
          <Section title="團體">
            <BarList rows={stats.groups} empty="還沒有標記團體的小卡。" />
          </Section>
          <Section title="成員">
            <BarList rows={stats.members.slice(0, 12)} empty="還沒有標記成員的小卡。" />
          </Section>
          <Section title="來源">
            <BarList rows={stats.sources} empty="還沒有標記來源的小卡。" />
          </Section>
          <Section title="卡種">
            <BarList rows={stats.cardTypes} empty="還沒有標記卡種的小卡。" />
          </Section>
          <Section title="持有狀態">
            <BarList rows={stats.statuses} empty="還沒有標記持有狀態的小卡。" />
          </Section>
          <Section title="套卡進度">
            <SetProgress cards={cards} collections={collections} />
          </Section>
        </div>
      </div>
    </>
  );
}
