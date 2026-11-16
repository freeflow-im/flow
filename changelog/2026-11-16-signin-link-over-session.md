# Sign-in links work in a browser signed in as someone else

- [web] A `?signin=` or `?reset=` link now owns the screen over a live session, as a setup link does: using it signs in as the person it was sent to, with "Stay signed in as …" to keep the current one. Before, it was ignored and the other person stayed signed in.

## Feature

- Opening a sign-in link from your email now signs you in, even if the browser was signed in as someone else.
