# Provisioning: the platform subdomain gets its DKIM record

- `[server]` With a provider that makes DKIM keys itself (MXRoute), `<slug>.freeflow.im`'s zone is written again once the domain exists at the provider, so the DKIM TXT lands beside MX, SPF and DMARC. Found on the first live run: the record was missing.
