// make-admin.js — mark an existing Firebase Auth user as a CafeQ admin.
//
// 1. Create the account first: Firebase console -> Authentication -> Users ->
//    Add user (email + password chosen by that person). Email/Password sign-in
//    must be enabled under Authentication -> Sign-in method.
// 2. Then run:   npm run make-admin -- someone@example.com
//    (or remove: npm run make-admin -- someone@example.com --remove)
//
// This writes/deletes admins/{uid}. Clients can never write that collection
// (firestore.rules), so only someone holding admin credentials can do this.
// Uses the same credentials as seed-firestore.js (key file OUTSIDE the repo, or
// `gcloud auth application-default login`). Free on the Spark plan.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const email = process.argv.slice(2).find((a) => a.includes("@"));
const remove = process.argv.includes("--remove");
const projectId = process.env.FIREBASE_PROJECT_ID;
if (!email || !projectId) {
  console.error("Usage: npm run make-admin -- someone@example.com [--remove]   (needs FIREBASE_PROJECT_ID in .env)");
  process.exit(1);
}

initializeApp({ projectId, credential: applicationDefault() });
let user;
try {
  user = await getAuth().getUserByEmail(email);
} catch {
  console.error(`No Firebase Auth user with email ${email}. Create it first (Authentication -> Users -> Add user).`);
  process.exit(1);
}
const ref = getFirestore().doc(`admins/${user.uid}`);
if (remove) {
  await ref.delete();
  console.log(`Removed admin rights from ${email} (uid ${user.uid}).`);
} else {
  await ref.set({ email, added_at: FieldValue.serverTimestamp() });
  console.log(`${email} (uid ${user.uid}) is now a CafeQ admin. Sign in at /admin.html.`);
}
