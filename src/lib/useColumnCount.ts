import { useEffect, useState, type RefObject } from 'react';

const MIN_TILE = 148;
const GAP = 12;
const MAX_COLUMNS = 6;

/**
 * Column count for the virtualised card wall, derived from the container's own
 * width rather than viewport breakpoints so the two layouts (plain CSS grid and
 * virtualised rows) stay visually identical.
 */
export function useColumnCount(ref: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(2);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = (width: number) => {
      const fit = Math.floor((width + GAP) / (MIN_TILE + GAP));
      setColumns(Math.max(2, Math.min(MAX_COLUMNS, fit)));
    };

    measure(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return columns;
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) return [items];
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
