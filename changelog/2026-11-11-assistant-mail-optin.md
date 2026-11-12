# Assistant mail is opt-in

- `[server]` An assistant's sender allowlist starts empty (the sponsor's own addresses are no longer implied) and its mailbox is never checked while it is empty; with any sender named it is checked every ten minutes instead of every minute. Changing the list starts or stops the checks at once.
- `[web]` Docs Settings says so beside the list.
- `[qa]` `e2e-assistant-mail.mjs`: nothing is read while the list is empty; Ann adds herself, then is answered and Mallory refused.

## Feature

- Your assistant reads no mail until you list who may mail it in Settings (add your own address to mail it yourself); then it checks every ten minutes.
