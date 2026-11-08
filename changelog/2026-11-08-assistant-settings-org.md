# Assistant settings are saved for the organization in the bar

- `[web]` Docs' Settings page reads and saves the assistant's provider and keys with `?workspace=` naming the organization selected in the bar, as the chat's turns already did. Without it the Worker fell back to the caller's first organization, so a key saved in one organization went to another and the chat there answered "not configured on this server".
- `[web]` The Settings page says the settings are for the selected organization, since each account keeps its own.
