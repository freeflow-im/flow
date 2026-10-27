# Push to Android devices over FCM (ANDROID.md phase 3, server half)

- `[server]` An FCM HTTP v1 driver behind the existing `PushSender` seam,
  selected per device platform beside the APNs driver: same recipient set,
  same mute/DND gate, same payload — translated on the way out. On when
  `FLOW_FCM_SERVICE_ACCOUNT` names a Firebase service-account key; the dev
  driver otherwise. `device_tokens` accepts `'android'` rows (the APNs-only
  columns become optional; migration 0047), and the push payload carries
  `kind` so a client can pick a notification channel. No client sends an
  Android token yet; the Capacitor shell that will is the next PR.
