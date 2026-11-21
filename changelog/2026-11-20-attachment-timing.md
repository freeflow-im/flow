# Attachment timing details

- `[server]` An attachment request's record and `Server-Timing` say how it was read (`kept`, its own `part`, or the
  `whole` message parsed), its size, and `download: true` for Mail's Download links.
- `[web]` Mail's call timings carry the bytes received, and a call answered from the browser's cache is marked
  `cache: browser` without the stored server timing.
