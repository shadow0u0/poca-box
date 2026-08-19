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

/**
 * Stable 53-bit string hash (cyrb53). Deterministic across devices and runs —
 * unlike anything seeded from randomness — which is the whole point of its one
 * use below.
 */
function hash53(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The id a seeded default gets, derived from its table and name rather than
 * drawn at random.
 *
 * Random ids were correct while every device stood alone, and wrong the moment
 * sync arrived: sync matches rows by id, so two devices seeding the same
 * "官方小卡" produced two unrelated rows and every new device added another
 * full set of defaults. Deriving the id from the name means every device
 * independently produces the *same* row, and the merge collapses them.
 *
 * Only `[A-Za-z0-9-]` comes out, because this doubles as a Firestore document id.
 */
export function builtinId(table: string, name: string): string {
  return `builtin-${table}-${hash53(nameKey(name))}`;
}
