# Saved assistant keys survive a restart of the Docs object

- `[server]` The Worker's Docs object sealed the assistant's API keys and connector credentials with a random key per instance (no CONNECTOR_ENCRYPTION_KEY, no key file), so a saved key stopped working whenever the object restarted. It now seals them with FLOW_DATA_KEY when no CONNECTOR_ENCRYPTION_KEY is set.
- `[server]` A saved key the store cannot read counts as gone: saving a new one works, and a turn says "enter it again" instead of failing.

## Feature

- **Your assistant key stays saved.** A key entered in Settings › Assistant keeps working after the server restarts; if one ever cannot be read, you are asked to enter it again rather than seeing an error.
