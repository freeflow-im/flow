# The mail provider: the interface, a fake, and the OpenSRS client (platform phase 5.2)

- `[server]` `MailProvider` interface with `ProviderError` codes; `MAIL_PROVIDER` picks `opensrs` (OPENSRS_* secrets), `fake` (in memory, GreenMail servers) or the `none` placeholder.
- `[server]` OpenSRS Mail API client over fetch (`change_domain`, `change_user`, `get_user`, `delete_user`, `delete_domain`, DKIM), unit-tested against the documented examples; no live account yet.
- `[server]` The Domains list shows the provider's MX, SPF, DMARC and, once set, DKIM; the platform subdomain publishes the same records.
- `[server]` `POST /v1/workspaces/:id/domains/:domain/dkim` makes a WebCrypto RSA key, gives it to the provider, keeps it sealed in `domain_keys`, returns the TXT.
- `[server]` A domain left unverified for over 7 days no longer blocks another organization from adding it.
