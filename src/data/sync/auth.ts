import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
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
    default:
      return '登入失敗，請再試一次。';
  }
}

export async function signIn(): Promise<Account> {
  const { auth } = await getFirebase();
  const { GoogleAuthProvider, signInWithPopup } = await import('firebase/auth');
  try {
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    return toAccount(result.user);
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'unknown';
    throw new SignInError(describe(code), code);
  }
}

export async function signOut(): Promise<void> {
  const { auth } = await getFirebase();
  const { signOut: fbSignOut } = await import('firebase/auth');
  await fbSignOut(auth);
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
