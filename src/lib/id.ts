/**
 * UUIDs (not autoincrement) so two devices can create rows offline and still
 * merge without id collisions when cloud sync is added later.
 */
export function newId(): string {
  // `randomUUID` is typed as always-present but only exists in secure contexts
  // and newer Safari, so it is treated as optional here.
  const api = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof api?.randomUUID === 'function') return api.randomUUID();

  // Older Safari: build a v4 UUID from getRandomValues.
  const bytes = new Uint8Array(16);
  api.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Today as YYYY-MM-DD in the device's own timezone, not UTC. */
export function todayIso(): string {
  const d = new Date();
  const offset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 10);
}

/** Case- and whitespace-insensitive key used to detect duplicate names. */
export function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}
