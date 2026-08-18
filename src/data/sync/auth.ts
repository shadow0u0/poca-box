import { useEffect, useState } from 'react';
import type { Auth, User } from 'firebase/auth';
import { getFirebase } from './firebase';

/**
 * Google sign-in for cloud sync.
 *
 * Popup only, deliberately. `signInWithRedirect` was tested on a real iPhone
 * with the app installed to the home screen and silently failed: the round trip
 * completed but `getRedirectResult` came back empty, because Safari's tracking
 * prevention partitions the pending-auth state Firebase keeps under
 * firebaseapp.com. The popup flow succeeded on the same device, so it is the
 * only path offered here.
 */

export interface Account {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

function toAccount(user: User): Account {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
  };
}

export class SignInError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SignInError';
  }
}

/** Turn a Firebase auth error code into something worth showing a person. */
function describe(code: string): string {
  switch (code) {
    case 'auth/popup-blocked':
      return '瀏覽器擋下了登入視窗。請允許彈出視窗後再試一次。';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return '登入視窗被關閉了，沒有完成登入。';
    case 'auth/network-request-failed':
      return '連不上網路，請確認連線後再試。';
    case 'auth/unauthorized-domain':
      return '這個網域尚未在 Firebase 授權，請聯絡開發者。';
    case 'auth/timeout':
      return '登入視窗沒有把結果傳回來（Safari 常見的跨站限制）。請再試一次；若仍然卡住，改用 Safari 開同一個網址登入一次即可。';
    default:
      return '登入失敗，請再試一次。';
  }
}

/**
 * How long to wait for the popup before giving up.
 *
 * `signInWithPopup` can fail by never settling at all: the window opens, the
 * account is chosen, and the result — which comes back through a hidden iframe
 * on the Firebase auth domain — never arrives, because Safari partitions that
 * cross-site context. Without a deadline the button sits on "登入中…" forever
 * with no way out, which is the one outcome a person cannot act on.
 */
const SIGN_IN_TIMEOUT_MS = 75_000;

interface SignInKit {
  auth: Auth;
  signInWithPopup: typeof import('firebase/auth').signInWithPopup;
  GoogleAuthProvider: typeof import('firebase/auth').GoogleAuthProvider;
}

let kit: SignInKit | null = null;

/**
 * Load the auth SDK before it is needed.
 *
 * iOS only lets a page open a window while it still holds the user's tap. The
 * SDK is a few hundred KB behind a dynamic import, so loading it *inside* the
 * click handler spends that budget on a download and can leave `window.open`
 * with no gesture left. Called from the sync UI as the button is pressed down,
 * this makes the popup open in the same tick as the click.
 */
export async function preloadSignIn(): Promise<void> {
  if (kit) return;
  const { auth } = await getFirebase();
  const mod = await import('firebase/auth');
  kit = {
    auth,
    signInWithPopup: mod.signInWithPopup,
    GoogleAuthProvider: mod.GoogleAuthProvider,
  };
}

export async function signIn(): Promise<Account> {
  // Slow path only when the preload has not finished — correctness first, even
  // though the awaits here are what can cost the gesture.
  if (!kit) await preloadSignIn();
  const ready = kit!;

  try {
    const result = await Promise.race([
      ready.signInWithPopup(ready.auth, new ready.GoogleAuthProvider()),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new SignInError(describe('auth/timeout'), 'auth/timeout')),
          SIGN_IN_TIMEOUT_MS,
        ),
      ),
    ]);
    return toAccount(result.user);
  } catch (e) {
    if (e instanceof SignInError) throw e;
    const code = (e as { code?: string }).code ?? 'unknown';
    throw new SignInError(describe(code), code);
  }
}

export async function signOut(): Promise<void> {
  const { auth } = await getFirebase();
  const { signOut: fbSignOut } = await import('firebase/auth');
  await fbSignOut(auth);
}

/**
 * A Firebase ID token for the signed-in user, or null when signed out.
 *
 * The SDK caches these and refreshes them automatically shortly before the one
 * hour expiry, so the usual call is free. `force` re-mints one, which is what a
 * 401 from our own Worker calls for — the only way a valid session produces one
 * is a token that expired between being read and being used.
 */
export async function getIdToken(force = false): Promise<string | null> {
  const { auth } = await getFirebase();
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken(force);
}

/** Currently signed-in account, or null. Resolves once Firebase has restored state. */
export async function currentAccount(): Promise<Account | null> {
  const { auth } = await getFirebase();
  const { onAuthStateChanged } = await import('firebase/auth');
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user ? toAccount(user) : null);
    });
  });
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; account: Account };

/**
 * Subscribe to sign-in state.
 *
 * `enabled` stays false until something actually needs auth, so merely opening
 * 設定 does not pull the Firebase SDK over the network for a user who has never
 * turned sync on.
 */
export function useAuth(enabled = true): AuthState {
  const [state, setState] = useState<AuthState>(
    enabled ? { status: 'loading' } : { status: 'signed-out' },
  );

  useEffect(() => {
    if (!enabled) return;
    let stop: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const { auth } = await getFirebase();
        const { onAuthStateChanged } = await import('firebase/auth');
        if (cancelled) return;
        stop = onAuthStateChanged(auth, (user) => {
          setState(user ? { status: 'signed-in', account: toAccount(user) } : { status: 'signed-out' });
        });
      } catch (e) {
        console.error('auth init failed', e);
        if (!cancelled) setState({ status: 'signed-out' });
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [enabled]);

  return state;
}
