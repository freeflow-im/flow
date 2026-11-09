# MXRoute is the hosted mail provider

- `[server]` `MAIL_PROVIDER=mxroute` with `MXROUTE_SERVER`, `MXROUTE_USERNAME` and `MXROUTE_API_KEY`: a client for MXRoute's REST API (domains, email accounts, DNS info, verification key), unit-tested against its OpenAPI document. OpenSRS stays selectable; no OpenSRS account was ever opened.
- `[server]` A provider may ask for its own ownership TXT before taking a domain: the Domains list shows it beside ours (purpose `provider`), the platform zone publishes it before the domain is made, and provisioning retries while DNS catches up (`pending`), or stops with the record's name on an organization's own domain.
- `[server]` A provider may manage DKIM itself: "Set up DKIM" then makes the domain at the provider and returns the provider's record; the directory keeps no key.
- `[server]` A provider without a suspend switch suspends a mailbox by taking its password; a resume gives it a fresh one and writes it to the Mail object.
- `[server]` `MailProvider.records` is now async.
