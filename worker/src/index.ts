import { createRemoteJWKSet, jwtVerify } from 'jose';

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
 */

export interface Env {
  PHOTOS: R2Bucket;
  FIREBASE_PROJECT_ID: string;
  /** Comma-separated origins allowed to call this Worker. */
  ALLOWED_ORIGINS: string;
  /**
   * Test-only: overrides the JWKS endpoint so a local run can verify tokens
   * signed by a throwaway key. Never set in production.
   */
  JWKS_URL?: string;
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
/** Compressed photos are a few hundred KB; a generous ceiling. */
const MAX_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request.headers.get('Origin'), env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const uid = await verifyUid(request, env);
    if (!uid) return json({ error: 'unauthorized' }, 401, cors);

    const parts = new URL(request.url).pathname.split('/').filter(Boolean);

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
      await env.PHOTOS.put(key, body, {
        httpMetadata: { contentType: request.headers.get('Content-Type') ?? 'image/webp' },
      });
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
      await env.PHOTOS.delete(key);
      return json({ ok: true }, 200, cors);
    }

    return json({ error: 'method not allowed' }, 405, cors);
  },
};
