# Android push, the app half (ANDROID.md phase 3)

- `[android]` `[web]` The Android shell registers its FCM token with each
  Flow connection at sign-in (routing id = the connection, `badgeMode: omit`,
  as macOS does) and drops it at sign-out; the per-kind notification
  channels come from one list in `@flow/shared`, which the server's FCM
  driver now uses too. A tap on a notification reaches the app through the
  host seam's `notifications.onClick`, the same path a desktop banner click
  takes, and lands in the conversation.

## Feature

- **Android notifications.** Mentions, direct messages, thread replies and
  the rest reach your Android phone even when Flow is closed, and tapping
  one takes you straight to the message. Each kind is its own channel in the
  phone's notification settings, so muting reactions but not mentions is a
  system switch.
