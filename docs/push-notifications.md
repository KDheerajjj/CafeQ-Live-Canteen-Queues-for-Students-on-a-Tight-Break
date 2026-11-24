# Push notifications: requirements and design (Phase 2, not built yet)

**Status:** requirements and design only. Nothing in this document is implemented. Phase 1 has
no notification code; the `TODO(phase-2-notify)` comment in `public/js/dashboard.js` points
here.

## 1. The problem

A day scholar's break is short. The useful moment to know where to eat is **just before class
ends**, while they're still sitting in class, not after they've walked out and opened the app.

> *"10 minutes before my class ends, tell me which cafe I can eat at and still get back in time."*

Example notification:

> **CafeQ — break in 10 min**
> 🟢 Mingos Canteen: no wait (~2 min, high confidence). M M Foods is packed.

Tapping it opens the dashboard.

## 2. Why Phase 1 can't do this

1. **A closed web app can't wake itself up.** Browsers don't run a PWA's code on a timer while
   it's closed. The Notification Triggers API that would have allowed this was abandoned. A push
   message **sent from a server** is the only reliable way to show a notification at a chosen time.
2. **Sending push messages needs a server.** Firebase Cloud Messaging (FCM) itself is free on
   Spark, but a message can only be sent with **admin credentials**, which must never be in the
   browser. Something trusted has to run on a schedule.
3. **No background location.** Browsers don't allow location reads while the app is closed, so
   a notification can't use the student's live position. It uses reference-point walk times
   (`walk_min`) or a "usual starting point" the student saves (see FR-6).

## 3. Constraints carried over from Phase 1

| # | Constraint | Consequence |
|---|---|---|
| C1 | **Zero cost, no billing** | No Cloud Functions (they need Blaze). The scheduler has to be free (see §6). |
| C2 | **No login** | Subscriptions are tied to the anonymous uid. Clearing site data means re-subscribing. |
| C3 | **Minimal personal data** | Store reminder *times* only: no timetable, subject names, location or contact details. |
| C4 | **Vendors not involved** | Notification content comes from crowd reports only. |
| C5 | **Honest estimates** | Notifications say "est." and include confidence, the same as the dashboard. |

## 4. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | The student turns reminders on with an explicit tap ("🔔 Remind me before my break"). The browser permission prompt only appears **after** that tap, never on page load. | Must |
| FR-2 | The student enters **when their class ends** (e.g. 12:30) and on which **weekdays**. They can add several (one per break). | Must |
| FR-3 | Lead time defaults to **10 min** before the class end, adjustable from 5 to 20 min. The app stores the reminder time, e.g. 12:20. | Must |
| FR-4 | At the reminder time the student gets **one** notification with the best cafe right now (same status engine and "Go" logic as the app), plus a short line on the others. | Must |
| FR-5 | If no cafe has a report in the last 15 min, still notify, honestly: "No recent reports — open CafeQ or report when you get there." | Must |
| FR-6 | Optional "usual starting point" (e.g. a block name chosen from a list) so walk times fit the student better than the default reference point. | Should |
| FR-7 | Tapping the notification opens the dashboard (`/`). | Must |
| FR-8 | The student can see, edit, pause and delete reminders, and turn notifications off completely. Turning off deletes the stored token. | Must |
| FR-9 | No reminders on holidays or when paused. A global "pause all" covers exam weeks and vacations. | Should |
| FR-10 | One notification per reminder per day, at most. No retries that could cause duplicates. | Must |

## 5. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 **Timing** | Arrives within ±5 min of the reminder time, and never more than 5 min late. (See the GitHub Actions caveat in §6.) |
| NFR-2 **Platforms** | Android Chrome (browser or installed app): full support. Desktop Chrome, Edge and Firefox: supported. **iPhone: only iOS 16.4+ and only when CafeQ is added to the Home Screen.** The app must explain this instead of failing silently. |
| NFR-3 **Privacy** | Stored per device: FCM token, reminder times, weekdays, timezone, optional starting-point id. No names, emails, timetables or GPS. Tokens unused for 60 days are deleted. |
| NFR-4 **Security** | Admin credentials live only in the scheduler's secret store, never in the repo or the browser. A device can only read and write its **own** subscription (Firestore rules). |
| NFR-5 **Cost** | Stays inside Spark's free quotas (§8). |
| NFR-6 **Reliability** | If a run fails, the next run must not send yesterday's reminders. Each subscription stores `last_sent` per reminder. |
| NFR-7 **Explainability** | Logic stays readable and reuses `status-engine.js` unchanged, for the academic report. |

## 6. Architecture options for the scheduled sender

Every option uses the same browser side (§7) and the same Firestore data (§9). They differ only
in **what runs every few minutes to send due notifications**.

| Option | Cost | Billing needed? | Timing accuracy | Verdict |
|---|---|---|---|---|
| **A. GitHub Actions cron** (public repo) | Free (unlimited minutes for public repos) | **No** | Scheduled every 5 min, but GitHub may delay runs by several minutes, more at busy times | ✅ **Recommended for Phase 2** |
| B. Firebase Cloud Functions (scheduled) | Usually within the free tier | **Yes, Blaze plan** | ~1 min | ❌ Breaks C1. Revisit only if the department pays for Blaze. |
| C. Always-on free VM or host (e.g. Google Cloud e2-micro free tier, Render, Fly) | Free tier | Most need a card on file | Good | ⚠ Possible, but more to run, and "free with card" conflicts with C1 |
| D. In-page timer only (Notification API + `setTimeout`) | Free | No | Only works if the app is **open** | ⚠ Fallback only; doesn't meet FR-4 while the app is closed |

**Recommended: Option A.**
- A workflow `.github/workflows/send-reminders.yml` runs on `schedule: cron "*/5 * * * *"`, plus
  `workflow_dispatch` for manual tests.
- It runs `node scripts/send-reminders.js` using the **Firebase Admin SDK**, which is already a
  dev dependency.
- The service-account key goes into a **GitHub Actions secret** (`FIREBASE_SERVICE_ACCOUNT`),
  never into a file in the repo.
- Caveats to accept and document:
  - Runs can be **late**: the script sends everything due since the last successful run, but
    skips anything more than 10 minutes old.
  - GitHub **disables scheduled workflows after 60 days with no repo activity**. Push a commit,
    or re-enable the workflow, each term.

## 7. Browser side

1. **VAPID key.** In the Firebase console go to Project settings → Cloud Messaging → *Web Push
   certificates* → Generate key pair. The **public** key goes in `config.js` as
   `FCM_VAPID_PUBLIC_KEY`. It's public by design, like the rest of the web config.
2. **Service worker.** Keep **one** service worker. Add FCM to `public/service-worker.js` with
   `importScripts` of the Firebase *compat* messaging SDK, plus a `notificationclick` handler
   that opens `/`. Pass this registration to `getToken({ serviceWorkerRegistration, vapidKey })`
   so FCM doesn't register a second worker (`firebase-messaging-sw.js`).
3. **Reminders UI** (a `reminders.html` page or a panel on the dashboard):
   - "🔔 Remind me before my break" button, which triggers the permission prompt.
   - A list of reminders: class-end time, weekdays, lead time (default 10 min), pause and delete.
   - A platform hint: iPhone users have to add CafeQ to the Home Screen first.
4. **Write** the subscription document (§9) under the device's anonymous uid. Refresh the token
   whenever the app opens (`getToken` returns the current one), and delete the document and
   token when the student turns notifications off.

## 8. Quota check (Spark, free)

Assume 500 subscribed students, about 2 reminders each, on weekdays.

| Item | Per day | Spark limit |
|---|---|---|
| Sender runs (every 5 min) | 288 | n/a (GitHub) |
| Reads: due subscriptions (a query on the next time slot only) | ~1,000 | 50,000 |
| Reads: recent `reports` per run that has something due | ~40 runs × ~50 = ~2,000 | 50,000 |
| Writes: `last_sent` updates | ~1,000 | 20,000 |
| FCM messages | ~1,000 | FCM has no per-message cost |

Well inside the free limits.

## 9. Data model

**`subscriptions/{uid}`**: document id = the anonymous auth uid (one per device).

| field | type | notes |
|---|---|---|
| `token` | string | FCM registration token |
| `tz` | string | e.g. `"Asia/Kolkata"` |
| `paused` | bool | global pause (FR-9) |
| `start_point` | string \| null | optional id of a known campus block (FR-6) |
| `reminders` | array (max 6) | `{ id, at: "12:20", days: [1,2,3,4,5], class_end: "12:30", lead_min: 10, last_sent: "2027-01-12" \| null }` |
| `slots` | array of strings | denormalised `"<day>-<HH:MM>"` for each reminder, so the sender can run `array-contains` on the current slot |
| `created_at`, `updated_at` | timestamp | `updated_at == request.time` |

**Rules sketch** (added to `firestore.rules` when this is built):

```
match /subscriptions/{uid} {
  allow read, delete: if request.auth != null && request.auth.uid == uid;
  allow create, update: if request.auth != null && request.auth.uid == uid
    && request.resource.data.keys().hasOnly(['token','tz','paused','start_point','reminders','slots','created_at','updated_at'])
    && request.resource.data.token is string && request.resource.data.token.size() < 4096
    && request.resource.data.reminders is list && request.resource.data.reminders.size() <= 6
    && request.resource.data.updated_at == request.time;
}
```

The sender uses the Admin SDK, so it can read every subscription. No client can read anyone
else's.

## 10. Sender algorithm (`scripts/send-reminders.js`)

```
now   = current time in Asia/Kolkata
slots = every 5-minute slot in (last_successful_run, now], capped at the last 10 minutes
for each slot:
    subs = subscriptions where slots array-contains slot, and paused == false
    skip reminders whose last_sent == today            (FR-10, NFR-6)
statuses = computeStatus() per cafe from reports in the last 15 min   (reuses status-engine.js)
for each due reminder:
    trips = evaluateTrip(available = lead_min + break length if known, else rank by walk + wait)
    body  = best "Go" cafe, or the honest no-data message                (FR-4, FR-5)
    send via admin.messaging().send({ token, notification, webpush: { fcmOptions: { link: "/" } } })
    on success: set last_sent = today
    on "registration-token-not-registered": delete the subscription
```

The status logic comes straight from `public/js/status-engine.js`. It's pure ESM, so Node can
import it unchanged, and the notification and the dashboard can never disagree.

## 11. Implementation checklist

- [ ] Generate the VAPID key pair (console) and add `FCM_VAPID_PUBLIC_KEY` to `config.js`
- [ ] Add FCM (compat) and `notificationclick` handling to `service-worker.js`; bump `CACHE_VERSION`
- [ ] Reminders UI with permission flow, platform hints, and edit/pause/delete
- [ ] `subscriptions` rules and the `slots` index; deploy with `npm run deploy:rules`
- [ ] `scripts/send-reminders.js` (Admin SDK + status-engine) with a dry-run flag
- [ ] `.github/workflows/send-reminders.yml` (cron every 5 min + manual trigger)
- [ ] GitHub secret `FIREBASE_SERVICE_ACCOUNT` (create a **separate** service account with only
      Firestore and FCM access; don't reuse the seeding key)
- [ ] Token cleanup (60 days unused) and documentation in the README
- [ ] Unit tests: slot calculation, `last_sent` de-duplication, message wording

## 12. Test plan

1. **Unit:** the slot and catch-up maths handles late runs, midnight, weekday changes and
   duplicate runs.
2. **Dry run:** `node scripts/send-reminders.js --dry-run` prints who would be notified and
   with what text, without sending anything.
3. **Device:** Android Chrome. Subscribe, set a reminder 6 minutes ahead, lock the phone, and
   check the notification arrives and opens the dashboard.
4. **iPhone:** in Safari (not installed) the app shows the Home Screen hint. Installed on
   iOS 16.4+, the notification arrives.
5. **Turning off** deletes the subscription document and no more notifications arrive.

## 13. Decisions needed before building

1. Is GitHub Actions timing (sometimes several minutes late) acceptable? If it must be on the
   minute, Option B needs the department to fund Blaze.
2. Should a reminder still fire when there's no recent data (FR-5)? Recommended: yes, honestly
   worded.
3. Should notifications go out on weekdays only by default, and should holidays come from a
   simple campus calendar list kept in the repo?
4. Who owns the sender's service account and its secret after the project hand-over?
