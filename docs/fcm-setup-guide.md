# Push notifications (FCM / Web Push) setup

## How it works

CafeQ uses the **standard Web Push protocol** with **VAPID** keys. On Android Chrome (and desktop
Chrome/Edge), the browser's push subscription points at Firebase Cloud Messaging
(`https://fcm.googleapis.com/fcm/send/...`), so FCM delivers every message — but the page needs
no Firebase SDK and the server needs no Firebase service account. The server signs each
message with the VAPID private key and sends it with `pywebpush`.

```
Browser ──subscribe(VAPID public key)──► push service (FCM) ──► PushSubscription
Browser ──POST /api/subscribe {endpoint, keys, break_time}──► CafeQ DB
CafeQ   ──every minute: break in 10 min? ──pywebpush (VAPID-signed)──► FCM ──► sw.js ──► notification
```

## 1. Generate VAPID keys (once)

```bash
python scripts/send_test_notification.py --gen-keys
```

Copy the two lines into `.env`:

```env
VAPID_PUBLIC_KEY=B...   # safe to expose; the page downloads it
VAPID_PRIVATE_KEY=...   # SECRET — never commit
VAPID_EMAIL=mailto:your-email@example.com
```

Restart the server. `GET /api/notify/vapid-public-key` should now return `"enabled": true`, and the
"Get notified before your break 🔔" banner appears on supported browsers.

> **Do you need a Firebase project?** Not for Web Push. If your faculty asks for one, create a free
> project at console.firebase.google.com → Project settings → Cloud Messaging → *Web Push
> certificates* → **Import an existing key pair** and paste the same VAPID keys, so the Firebase
> console and CafeQ use one identity. `FCM_SERVER_KEY` is only for Firebase's legacy HTTP API,
> which CafeQ does not use; leave the placeholder.

## 2. Test it

1. Push requires a **secure context**: `http://localhost` works for development; on a phone use the
   HTTPS Render URL.
2. Open the dashboard in Chrome → tap **Enable** → allow notifications → choose a break time.
3. Send a test push to every subscriber:

   ```bash
   python scripts/send_test_notification.py
   ```

4. To test the scheduler, subscribe with a break time 10 minutes from now and wait for the next
   minute boundary, or run `python scripts/send_test_notification.py --reminders`.

## Browser support

| Browser | Works? | Notes |
|---|---|---|
| Android Chrome / Edge / Samsung Internet | ✅ | Delivered via FCM |
| Desktop Chrome / Edge / Firefox | ✅ | Firefox uses Mozilla's push service — same code |
| iOS Safari 16.4+ | ⚠️ | Only after **Add to Home Screen**; in a normal tab the Push API is missing |
| iOS Safari < 16.4, in-app browsers | ❌ | Banner is hidden silently, by design |

The app never shows an error when push is unsupported: `notifications.js` checks for Service
Worker + PushManager + Notification + secure context and simply doesn't show the banner.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No banner | VAPID keys missing (`enabled: false`), notifications blocked for the site, banner dismissed earlier (clear site data), or unsupported browser |
| "Couldn't turn on reminders" | Usually a VAPID key mismatch — regenerate, restart, clear site data, subscribe again |
| Push sent but nothing shows | Check Android's notification settings for Chrome; check `sw.js` is registered (DevTools → Application) |
| Subscribers disappear | Expected: the push service returned 404/410 (expired), so the row was deleted |
| Reminders never fire on Render | Free instances sleep when idle — see "Keeping reminders alive" in deployment-guide.md |
