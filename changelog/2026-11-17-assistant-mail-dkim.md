# The assistant's mailbox checks senders' DKIM signatures itself

- `[server]` An allowlisted sender is taken when the message's own DKIM signature for its From domain verifies against the signer's key in DNS (rsa-sha256; no `l=`). MXRoute writes no Authentication-Results, so every allowlisted sender was refused; its X-DKIM / X-DMARC-Status headers can be forged and are not trusted.

## Feature

- **Mail to your assistant now arrives.** Messages from the senders you allow reach your assistant instead of its Refused folder.
