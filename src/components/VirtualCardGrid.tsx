import { useRef } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { CardGrid, CardTile } from './CardTile';
import { chunk, useColumnCount } from '../lib/useColumnCount';
import type { Card } from '../data/types';

/**
 * The card wall. Below `VIRTUALIZE_ABOVE` cards it is a plain CSS grid; past
 * that the rows are windowed, so a collection of a few thousand cards still
 * scrolls smoothly on a phone.
 */
const VIRTUALIZE_ABOVE = 60;

export interface CardGridProps {
  cards: Card[];
  subtitleFor?: (card: Card) => string | undefined;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggle?: (id: string) => void;
}

export function VirtualCardGrid({
  cards,
  subtitleFor,
  selectable,
  selectedIds,
  onToggle,
}: CardGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const columns = useColumnCount(containerRef);

  const tile = (card: Card) => (
    <CardTile
      key={card.id}
      card={card}
      subtitle={subtitleFor?.(card)}
      selectable={selectable}
      selected={selectedIds?.has(card.id)}
      onToggle={onToggle}
    />
  );

  if (cards.length <= VIRTUALIZE_ABOVE) {
    return (
      <div ref={containerRef}>
        <CardGrid>{cards.map(tile)}</CardGrid>
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      <VirtualRows
        rows={chunk(cards, columns)}
        columns={columns}
        containerRef={containerRef}
        renderTile={tile}
      />
    </div>
  );
}

function VirtualRows({
  rows,
  columns,
  containerRef,
  renderTile,
}: {
  rows: Card[][];
  columns: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  renderTile: (card: Card) => React.ReactNode;
}) {
  // Scrolls with the document (not a nested scroller) so iOS keeps its
  // rubber-banding and the address bar still collapses on scroll.
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 260,
    overscan: 4,
    scrollMargin: containerRef.current?.offsetTop ?? 0,
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      <div
        style={{
          position: 'absolute',
          insetInline: 0,
          top: 0,
          transform: `translateY(${(items[0]?.start ?? 0) - virtualizer.options.scrollMargin}px)`,
        }}
      >
        {items.map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="grid gap-3 pb-3"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {rows[item.index].map(renderTile)}
          </div>
        ))}
      </div>
    </div>
  );
}
