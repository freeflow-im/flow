# Mail e2e: consent groups from the manifests, a deterministic prefetch probe, and a steady GreenMail connect

- `[qa]` `e2e-mail-mcp.mjs` reads the consent groups and their defaults from the app manifests, so a new app's group no longer breaks it.
- `[qa]` `e2e-mail-mcp.mjs` creates Bo's GreenMail mailbox before he connects: GreenMail auto-creates users on first login, and the connect's concurrent IMAP and SMTP logins raced to create it (422).
- `[qa]` `e2e-mail.mjs` stages its 40 fillers in an uncached folder and moves them into INBOX at once, after waiting out a real alarm run that is due soon, so only the test's pass runs before the "not prefetched" probe.
