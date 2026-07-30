import { Link } from 'react-router-dom';
import { usePhotoUrl } from '../data/photos';
import type { Card } from '../data/types';
import { IconCheck, IconImage } from './icons';

/** One photocard in a grid. Doubles as a selectable tile in multi-select mode. */
export function CardTile({
  card,
  subtitle,
  selectable,
  selected,
  onToggle,
}: {
  card: Card;
  subtitle?: string;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (id: string) => void;
}) {
  const url = usePhotoUrl(card.frontPhotoId, 'thumb');

  const body = (
    <>
      <div className="aspect-photocard relative overflow-hidden rounded-xl bg-surface-2">
        {url ? (
          <img
            src={url}
            alt={card.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted">
            <IconImage className="h-6 w-6" />
          </div>
        )}
        {selectable && (
          <span
            className={`absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors ${
              selected ? 'border-accent bg-accent text-on-accent' : 'border-white/80 bg-black/25'
            }`}
          >
            {selected && <IconCheck className="h-3.5 w-3.5" />}
          </span>
        )}
      </div>
      <p className="mt-1.5 truncate text-sm font-medium">{card.name}</p>
      {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
    </>
  );

  if (selectable) {
    return (
      <button
        type="button"
        aria-pressed={selected}
        className="group block w-full text-left"
        onClick={() => onToggle?.(card.id)}
      >
        {body}
      </button>
    );
  }

  return (
    <Link to={`/cards/${card.id}`} className="group block">
      {body}
    </Link>
  );
}

/** Responsive photocard grid: 2 columns on a phone, up to 6 on a desktop. */
export function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {children}
    </div>
  );
}
