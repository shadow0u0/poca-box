import type { Card } from '../../data/types';

/**
 * Card-wall filter state. It lives in the URL query string so the back button,
 * a reload and a shared link all restore the same view.
 */
export interface CardFilter {
  q: string;
  groupIds: string[];
  memberIds: string[];
  sourceIds: string[];
  cardTypeIds: string[];
  statusIds: string[];
  albumIds: string[];
  folderIds: string[];
  from: string;
  to: string;
  sort: SortKey;
}

export type SortKey = 'acquired-desc' | 'acquired-asc' | 'name-asc' | 'price-desc' | 'price-asc';

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'acquired-desc', label: '收藏時間（新→舊）' },
  { key: 'acquired-asc', label: '收藏時間（舊→新）' },
  { key: 'name-asc', label: '名稱' },
  { key: 'price-desc', label: '價格（高→低）' },
  { key: 'price-asc', label: '價格（低→高）' },
];

export const EMPTY_FILTER: CardFilter = {
  q: '',
  groupIds: [],
  memberIds: [],
  sourceIds: [],
  cardTypeIds: [],
  statusIds: [],
  albumIds: [],
  folderIds: [],
  from: '',
  to: '',
  sort: 'acquired-desc',
};

/** Query-string key for each multi-select facet. */
const LIST_PARAMS = {
  groupIds: 'group',
  memberIds: 'member',
  sourceIds: 'source',
  cardTypeIds: 'type',
  statusIds: 'status',
  albumIds: 'album',
  folderIds: 'folder',
} as const;

export function parseFilter(params: URLSearchParams): CardFilter {
  const lists = Object.fromEntries(
    Object.entries(LIST_PARAMS).map(([field, key]) => {
      const raw = params.get(key);
      return [field, raw ? raw.split(',').filter(Boolean) : []];
    }),
  ) as Pick<CardFilter, keyof typeof LIST_PARAMS>;

  const sort = params.get('sort');
  return {
    ...EMPTY_FILTER,
    ...lists,
    q: params.get('q') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    sort: SORT_OPTIONS.some((o) => o.key === sort) ? (sort as SortKey) : 'acquired-desc',
  };
}

export function serializeFilter(filter: CardFilter): URLSearchParams {
  const params = new URLSearchParams();
  for (const [field, key] of Object.entries(LIST_PARAMS)) {
    const value = filter[field as keyof typeof LIST_PARAMS];
    if (value.length) params.set(key, value.join(','));
  }
  if (filter.q.trim()) params.set('q', filter.q.trim());
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.sort !== 'acquired-desc') params.set('sort', filter.sort);
  return params;
}

export function countActiveFacets(filter: CardFilter): number {
  return (
    filter.groupIds.length +
    filter.memberIds.length +
    filter.sourceIds.length +
    filter.cardTypeIds.length +
    filter.statusIds.length +
    filter.albumIds.length +
    filter.folderIds.length +
    (filter.from ? 1 : 0) +
    (filter.to ? 1 : 0)
  );
}

function matchesAny(selected: string[], value: string | undefined): boolean {
  // An empty facet means "no restriction", not "match nothing".
  if (selected.length === 0) return true;
  return !!value && selected.includes(value);
}

/** Facets combine with AND across dimensions and OR inside one dimension. */
export function applyFilter(cards: Card[], filter: CardFilter): Card[] {
  const q = filter.q.trim().toLocaleLowerCase();

  const filtered = cards.filter((card) => {
    if (!matchesAny(filter.groupIds, card.groupId)) return false;
    if (!matchesAny(filter.sourceIds, card.sourceId)) return false;
    if (!matchesAny(filter.cardTypeIds, card.cardTypeId)) return false;
    if (!matchesAny(filter.statusIds, card.statusId)) return false;
    if (!matchesAny(filter.albumIds, card.albumId)) return false;

    if (filter.memberIds.length && !filter.memberIds.some((m) => card.memberIds.includes(m)))
      return false;
    if (filter.folderIds.length && !filter.folderIds.some((f) => card.folderIds.includes(f)))
      return false;

    if (filter.from && card.acquiredAt < filter.from) return false;
    if (filter.to && card.acquiredAt > filter.to) return false;

    if (q) {
      const haystack = `${card.name} ${card.note ?? ''}`.toLocaleLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  return sortCards(filtered, filter.sort);
}

export function sortCards(cards: Card[], sort: SortKey): Card[] {
  const sorted = [...cards];
  switch (sort) {
    case 'acquired-asc':
      return sorted.sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt));
    case 'name-asc':
      return sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    case 'price-desc':
      // Cards with no price sink to the bottom either way rather than mixing in.
      return sorted.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
    case 'price-asc':
      return sorted.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    default:
      return sorted.sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt));
  }
}
