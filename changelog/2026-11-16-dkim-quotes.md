# Domains: the DKIM record no longer shows as missing when it is published

- [server] MXRoute's DKIM value comes quoted and split in two; it is now kept as plain text, so the records check matches what DNS returns, and the admin page shows and copies it without quotes.

## Feature

- The signing (DKIM) record on Domains & mail now shows as found once it is in your DNS, and copies without extra quote marks.
