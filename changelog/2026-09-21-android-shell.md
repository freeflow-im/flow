# Android shell: the web client in Capacitor, on the desktop's host seam (ANDROID.md)

- `[android]` `apps/android`: a Capacitor shell that signs in and chats — the
  Android counterpart of `apps/desktop` M1–M2. It exposes the desktop's
  `FlowDesktopBridge` (a document-start script for the synchronous
  credential snapshot, a Capacitor plugin for writes, the system browser and
  `flow://` links), so the web client reaches it through `host.ts` unchanged;
  credentials live in `EncryptedSharedPreferences`. Debug APK on PRs via
  `android.yml`; JUnit for the shell's own logic.
- `[web]` `lib/hostAndroid.ts` folds the shell's boot object and plugin into
  the bridge shape; `host.ts` adopts it when present. `platform` gains
  `'android'`.
- `[server]` The app's origin, `https://flow.localhost` (`ANDROID_ORIGIN`),
  is admitted as a bundled client the way `app://flow` is — in the browser
  policy, the handoff context and the Slack connector.
