# Shortcuts keep working after a click in a message

- `[mail]` A message's HTML body (a same-origin sandboxed iframe) relays its key presses to the window, so the keyboard shortcuts work after a click in the message put the focus there. Not while typing in a field the message contains; a key the app acted on is cancelled in the frame too.

## Feature

- **Keyboard shortcuts after clicking in a message.** Clicking a link or selecting text in a message no longer stops j and k, e, r and the other shortcuts from working.
