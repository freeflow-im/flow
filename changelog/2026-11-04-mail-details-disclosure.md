# Mail: the Details disclosure no longer folds the message

- `[web]` Clicking Details under a message's header opened the addresses and then collapsed the whole message, because the click
  also reached the header's open/close handler. The header now leaves the disclosure's clicks alone.

## Feature

- **Details works.** Click Details under a message's sender to see its From, To, Cc, Bcc and folder. The message stays open.
