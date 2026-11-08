# Mail e2e: the body prefetch checks hold for a fresh mailbox

- [qa] `e2e-mail.mjs` delivers more messages than one body pass fetches before probing an uncached body, so the prefetch checks pass for a fresh `MAIL_USER` too.
