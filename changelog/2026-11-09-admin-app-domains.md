# Admin: Domains & mail (phase 2)

- `[web]` The Admin app's **Domains & mail** section (`docs/specs/workspace-admin.md` §4): a Mail card (the provider's IMAP and SMTP hosts, the native accounts' mailbox counts, the retention period, Add a domain) and one card per domain. An organization's own domain is five steps to working mail: added, prove ownership (Verify), publish the mail records, **Turn on mail** (which makes the domain at the provider and brings back its DKIM record; the UI could not do this before), publish the signing record. Each record shows whether DNS has it; "Check again" rests five seconds. The platform subdomain is one card, managed by FreeFlow. Chat's Domains tab is gone.
- `[server]` `DomainDTO.atProvider` (set by "Turn on mail" as well as by provisioning), `AccountDTO.hosted`, and `GET /v1/config` `mail` (the provider's hosts) for the cards. Mail's "being set up" page points an admin at Admin › Domains & mail.

## Feature

Admins set up a domain for mail from one card: add it, prove it is theirs, publish the records shown (each marked present or missing), press "Turn on mail", publish the last record, and the card says "mail ready". The Mail card shows how many mailboxes are ready, being set up, or stopped.
