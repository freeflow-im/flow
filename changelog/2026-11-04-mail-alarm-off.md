# Mail: the prefetch cache's alarm can be switched off

- `[server]` `MAIL_ALARM = "off"` (wrangler.toml) stops the alarm: pages check the mail server themselves, as before the fresh-pages change, and bodies are read on open. Set in production while the alarm's CPU use (runs cut short by the Durable Object limit) is worked out.
