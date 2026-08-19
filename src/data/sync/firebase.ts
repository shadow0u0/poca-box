import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';

/**
 * Firebase is loaded on demand, never at startup.
 *
 * The SDK is a few hundred KB — more than the rest of the app put together —
 * and cloud sync is opt-in. Importing it lazily keeps the first paint for
 * someone who never signs in exactly as fast as it was before sync existed,
 * and keeps the app fully usable offline with no Firebase present at all.
 */

// Not a secret: this identifies the project. Access is controlled by the
// Firestore and Storage security rules, which are in this repository too.
const firebaseConfig = {
  apiKey: 'AIzaSyCoy6b1FNjlTq67xccsohCUikFhyFpyYk4',
  authDomain: 'poca-box.firebaseapp.com',
  projectId: 'poca-box',
  storageBucket: 'poca-box.firebasestorage.app',
  messagingSenderId: '43048402355',
  appId: '1:43048402355:web:f88d63d4f7ff131c5a5fc6',
};

let appPromise: Promise<{ app: FirebaseApp; auth: Auth }> | null = null;

/** Initialise Firebase once, on first use. Safe to call repeatedly. */
export function getFirebase(): Promise<{ app: FirebaseApp; auth: Auth }> {
  appPromise ??= (async () => {
    const [{ initializeApp, getApps, getApp }, authMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
    ]);
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);

    // Automated tests point auth at the local emulator so the real
    // `useSyncEnabled → useAuth → uid → startAutoSync` chain can be exercised
    // end to end. Production never sets this global.
    const emulator = (globalThis as { __POCABOX_AUTH_EMULATOR__?: string })
      .__POCABOX_AUTH_EMULATOR__;
    if (emulator) {
      authMod.connectAuthEmulator(auth, `http://${emulator}`, { disableWarnings: true });
    }
    // Explicit local persistence: without it a standalone PWA can lose the
    // session between launches.
    await authMod
      .setPersistence(auth, authMod.browserLocalPersistence)
      .catch((e) => console.warn('setPersistence failed', e));
    return { app, auth };
  })();
  return appPromise;
}

let firestorePromise: Promise<Firestore> | null = null;

/**
 * The Firestore handle, initialised once.
 *
 * Lives here rather than in the sync engine because `initializeFirestore` may
 * only be called once per app — a second caller wanting Firestore (deleting a
 * photo's metadata during cloud cleanup, say) cannot simply set up its own.
 */
export function getFirestore(): Promise<Firestore> {
  firestorePromise ??= (async () => {
    const { app } = await getFirebase();
    const { initializeFirestore, connectFirestoreEmulator } = await import('firebase/firestore');
    // Rows have optional fields that are genuinely `undefined`; without this
    // Firestore throws instead of simply omitting them.
    const fs = initializeFirestore(app, { ignoreUndefinedProperties: true });

    // Automated tests point the app at a local emulator. Guarded on an explicit
    // global so a production build can never be redirected by accident.
    const emulator = (globalThis as { __POCABOX_FIRESTORE_EMULATOR__?: string })
      .__POCABOX_FIRESTORE_EMULATOR__;
    if (emulator) {
      const [host, port] = emulator.split(':');
      connectFirestoreEmulator(fs, host, Number(port));
    }
    return fs;
  })();
  return firestorePromise;
}
