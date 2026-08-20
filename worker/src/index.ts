import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ALLOWED_UIDS } from './allowlist.generated';

/**
 * Photo storage for 小卡櫃, backed by Cloudflare R2.
 *
 * Firebase Cloud Storage requires a billing account on newer projects, so
 * photos live here instead. R2's free tier is 10 GB with no egress charges,
 * which suits a library that every new device downloads in full — and running
 * out only stops the service, it never produces a bill.
 *
 * Auth reuses the Firebase sign-in the app already has: the client sends its
 * Firebase ID token, this Worker verifies it against Google's public keys, and
 * the verified `sub` claim alone decides which prefix of the bucket a request
 * may touch. The uid is never taken from the URL, so a caller cannot ask for
 * someone else's photos.
 *
 * **Signing in is not the same as being allowed in.** Anyone with a Google
 * account can authenticate against the Firebase project, so a verified token
 * only says *who* the caller is. `ALLOWED_UIDS` — generated from
 * `firebase/allowlist.json`, the same source as the Firestore rules — says
 * whether they may be here at all. Without it a stranger who found the address
 * would spend the shared free quota and everyone's sync would stop when it ran
 * out. The Firestore rules enforce the identical list on the card data; each
 * side covers what the other cannot see.
 */

export interface Env {
  PHOTOS: R2Bucket;
  FIREBASE_PROJECT_ID: string;
  /** Comma-separated origins allowed to call this Worker. */
  ALLOWED_ORIGINS: string;
  /**
   * Per-person ceiling in bytes. The whole bucket is 10 GB on the free plan and
   * is shared, so one library must not be able to fill it: without a cap a
   * single account could stop everyone else from syncing. Defaults to 1 GiB.
   */
  LIMIT_BYTES?: string;
  /**
   * Test-only: overrides the JWKS endpoint so a local run can verify tokens
   * signed by a throwaway key. Never set in production.
   */
  JWKS_URL?: string;
  /**
   * Test-only: extra uids to treat as invited, comma separated. The automated
   * tests sign their own tokens for made-up accounts, which by definition are
   * not in `firebase/allowlist.json` and must never be. Deliberately absent
   * from `wrangler.toml` — same rule as `JWKS_URL`, and if it is ever set in
   * production it is a hole, so it is passed on the command line only.
   */
  ALLOW_UIDS?: string;
}

function isInvited(uid: string, env: Env): boolean {
  if (ALLOWED_UIDS.has(uid)) return true;
  const extra = env.ALLOW_UIDS?.split(',').map((s) => s.trim()) ?? [];
  return extra.includes(uid);
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUrl = '';

function getJwks(env: Env) {
  const url =
    env.JWKS_URL ??
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
  if (!jwks || jwksUrl !== url) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksUrl = url;
  }
  return jwks;
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
  // Echo the origin only when it is on the list; never reflect an arbitrary one.
  const allow = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

/** Verify a Firebase ID token and return its uid, or null. */
async function verifyUid(request: Request, env: Env): Promise<string | null> {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;

  try {
    const { payload } = await jwtVerify(header.slice(7), getJwks(env), {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
    });
    // `sub` is the uid. Checked explicitly so a token without one cannot end up
    // addressing the bucket root.
    const uid = payload.sub;
    return typeof uid === 'string' && uid.length > 0 ? uid : null;
  } catch {
    return null;
  }
}

function keyFor(uid: string, photoId: string, variant: 'full' | 'thumb'): string {
  return `users/${uid}/photos/${photoId}${variant === 'thumb' ? '.thumb' : ''}`;
}

/** Photo ids are UUIDs; anything else is rejected before it reaches the bucket. */
const PHOTO_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Compressed photos are a few hundred KB; a generous ceiling for one file. */
const MAX_BYTES = 8 * 1024 * 1024;
/** Per-person ceiling when `LIMIT_BYTES` is not set. */
const DEFAULT_LIMIT_BYTES = 1024 * 1024 * 1024;

function limitOf(env: Env): number {
  const n = Number(env.LIMIT_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT_BYTES;
}

/**
 * How many bytes one person is storing, cached briefly in the isolate.
 *
 * R2 has no "size of a prefix" call, so this adds up a listing. That is a
 * handful of Class A operations against a monthly free allowance of a million,
 * but it is too slow to repeat on every single upload of a first sync — hence
 * the cache, kept current by adding each write to it. Isolates come and go and
 * several may be live at once, so the number can lag reality by a little. That
 * is fine for a ceiling whose job is to stop one library swallowing the bucket,
 * not to bill anyone by the byte.
 */
const usageCache = new Map<string, { bytes: number; at: number }>();
const USAGE_TTL_MS = 60_000;

async function usageOf(uid: string, env: Env, force = false): Promise<number> {
  const hit = usageCache.get(uid);
  if (!force && hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.bytes;

  const prefix = `users/${uid}/photos/`;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.PHOTOS.list({ prefix, cursor, limit: 1000 });
    for (const obj of listed.objects) bytes += obj.size;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  usageCache.set(uid, { bytes, at: Date.now() });
  return bytes;
}

function adjustUsage(uid: string, delta: number) {
  const hit = usageCache.get(uid);
  if (hit) hit.bytes = Math.max(0, hit.bytes + delta);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request.headers.get('Origin'), env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const uid = await verifyUid(request, env);
    if (!uid) return json({ error: 'unauthorized' }, 401, cors);

    const parts = new URL(request.url).pathname.split('/').filter(Boolean);
    const invited = isInvited(uid, env);

    // GET /me → who the caller is and whether they are allowed here. The app
    // asks before it syncs, so someone who has not been invited yet gets told
    // exactly that, along with the code to send to whoever runs this space —
    // rather than a string of permission errors to decipher. `?usage=1` adds
    // the storage numbers, which cost a listing, so the sync loop leaves it off
    // and only the settings screen asks.
    if (request.method === 'GET' && parts.length === 1 && parts[0] === 'me') {
      const wantUsage = new URL(request.url).searchParams.get('usage') === '1';
      return json(
        {
          uid,
          invited,
          limitBytes: limitOf(env),
          ...(wantUsage && invited ? { usedBytes: await usageOf(uid, env) } : {}),
        },
        200,
        cors,
      );
    }

    // Everything below touches storage, so this is where the door is.
    if (!invited) return json({ error: 'not_invited', uid }, 403, cors);

    // GET /photos → the ids this user has stored, for diffing against local.
    if (request.method === 'GET' && parts.length === 1 && parts[0] === 'photos') {
      const prefix = `users/${uid}/photos/`;
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const listed = await env.PHOTOS.list({ prefix, cursor, limit: 1000 });
        for (const obj of listed.objects) {
          const name = obj.key.slice(prefix.length);
          if (!name.endsWith('.thumb')) ids.push(name);
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return json({ ids }, 200, cors);
    }

    // /photos/:id  and  /photos/:id/thumb
    if (parts[0] !== 'photos' || parts.length < 2 || parts.length > 3) {
      return json({ error: 'not found' }, 404, cors);
    }
    if (parts.length === 3 && parts[2] !== 'thumb') {
      return json({ error: 'not found' }, 404, cors);
    }
    const photoId = parts[1];
    if (!PHOTO_ID.test(photoId)) return json({ error: 'bad id' }, 400, cors);
    const key = keyFor(uid, photoId, parts.length === 3 ? 'thumb' : 'full');

    if (request.method === 'PUT') {
      const declared = Number(request.headers.get('Content-Length') ?? '0');
      if (declared > MAX_BYTES) return json({ error: 'too large' }, 413, cors);
      const body = await request.arrayBuffer();
      // Checked again after reading: Content-Length is caller-supplied.
      if (body.byteLength > MAX_BYTES) return json({ error: 'too large' }, 413, cors);

      const limit = limitOf(env);
      const used = await usageOf(uid, env);
      // Replacing an existing object frees what it held, so only the difference
      // counts — otherwise re-uploading the same photo would drift the total up
      // until the cache expired. Photos are immutable, so this is rare, but a
      // retried upload takes exactly this path.
      const existing = (await env.PHOTOS.head(key))?.size ?? 0;
      if (used - existing + body.byteLength > limit) {
        return json({ error: 'quota', usedBytes: used, limitBytes: limit }, 507, cors);
      }

      await env.PHOTOS.put(key, body, {
        httpMetadata: { contentType: request.headers.get('Content-Type') ?? 'image/webp' },
      });
      adjustUsage(uid, body.byteLength - existing);
      return json({ ok: true }, 200, cors);
    }

    if (request.method === 'GET') {
      const object = await env.PHOTOS.get(key);
      if (!object) return json({ error: 'not found' }, 404, cors);
      return new Response(object.body, {
        headers: {
          ...cors,
          'Content-Type': object.httpMetadata?.contentType ?? 'image/webp',
          // Photos are immutable: replacing one produces a new id.
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      });
    }

    if (request.method === 'DELETE') {
      // Read the size first: after the delete there is nothing left to ask.
      const freed = (await env.PHOTOS.head(key))?.size ?? 0;
      await env.PHOTOS.delete(key);
      adjustUsage(uid, -freed);
      return json({ ok: true }, 200, cors);
    }

    return json({ error: 'method not allowed' }, 405, cors);
  },
};
