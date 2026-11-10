# The browser extension reads pages built from `display: contents` wrappers

- `[web]` `browser_read` no longer skips elements styled `display: contents`, which `checkVisibility` calls hidden;
  LinkedIn wraps its whole profile in one, so the assistant saw only the navigation (477 → 12,795 characters).
