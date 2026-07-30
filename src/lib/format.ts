const dateFormatter = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/** `2025-03-14` → `2025年3月14日`. Parsed as local time, not UTC. */
export function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return dateFormatter.format(new Date(y, m - 1, d));
}

export function formatPrice(price?: number, currency?: string): string {
  if (price == null) return '—';
  const code = currency?.trim() || 'TWD';
  try {
    return new Intl.NumberFormat('zh-TW', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0,
    }).format(price);
  } catch {
    // Unknown/custom currency code — fall back to a plain number plus the code.
    return `${new Intl.NumberFormat('zh-TW').format(price)} ${code}`;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

export const CURRENCIES = ['TWD', 'KRW', 'JPY', 'USD', 'CNY', 'HKD'] as const;
