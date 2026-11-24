// firebase-init.js — initialise Firebase once and sign the device in anonymously.
//
// Anonymous Auth gives each browser a stable, random uid with no login screen
// and no personal data. We use it only to (a) satisfy the security rule
// "request.auth != null" when writing a report, and (b) apply the per-device
// cooldown. It is NOT an identity: clearing site data produces a new uid.

import { FIREBASE_CONFIG, FIREBASE_CONFIGURED, FIREBASE_SDK_VERSION } from "./config.js";

const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

let ready = null;

/**
 * Lazily load and initialise Firebase.
 * Resolves to { db, auth, fs } where `fs` is the Firestore module namespace
 * (collection, query, where, onSnapshot, ...), so pages don't each import it.
 * Rejects with a readable Error if config.js still has placeholder values.
 */
export function getFirebase() {
  if (ready) return ready;
  ready = (async () => {
    if (!FIREBASE_CONFIGURED) {
      throw new Error(
        "Firebase is not configured yet. Paste your web config into public/js/config.js."
      );
    }
    const [{ initializeApp }, authMod, fs] = await Promise.all([
      import(`${CDN}/firebase-app.js`),
      import(`${CDN}/firebase-auth.js`),
      import(`${CDN}/firebase-firestore.js`),
    ]);
    const app = initializeApp(FIREBASE_CONFIG);
    const auth = authMod.getAuth(app);
    const db = fs.getFirestore(app);
    return { app, db, auth, authMod, fs };
  })();
  return ready;
}

/**
 * Ensure the device is signed in anonymously; resolves to the uid.
 * Silent: no UI, no prompt. Re-uses the existing anonymous session if any.
 */
export async function ensureAnonUser() {
  const { auth, authMod } = await getFirebase();
  if (auth.currentUser) return auth.currentUser.uid;
  // Wait for the persisted session to load before deciding to create a new one.
  const existing = await new Promise((resolve) => {
    const off = authMod.onAuthStateChanged(auth, (user) => {
      off();
      resolve(user);
    });
  });
  if (existing) return existing.uid;
  const cred = await authMod.signInAnonymously(auth);
  return cred.user.uid;
}

/** Register the service worker (PWA offline shell). Safe to call on every page. */
export function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
    });
  }
}
