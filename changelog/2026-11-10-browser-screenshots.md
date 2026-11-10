# The assistant's web tools take screenshots and read LinkedIn-style pages

- `[web]` `[server]` New `browser_screenshot`: the extension captures the agent's tab (through the debugger, so a
  background tab works) and the Workspace, Mail and Calendar panels attach the picture to the tool results.
- `[web]` `browser_read` no longer skips `display: contents` wrappers, which `checkVisibility` calls hidden; LinkedIn
  wraps its whole profile in one (477 → 12,795 characters).
