# Android shell: the hardware back button (ANDROID.md phase 1)

- `[android]` `[web]` Back closes what is on top instead of leaving the app:
  an open modal or lightbox, then the thread, then the side panel, then it
  opens the drawer, and only then does the OS get the press. The host seam
  gains an optional `back` the Android shell provides (`host.back.onBack`);
  the desktop preload and a browser report none, so nothing changes there.
