# Chat visitors: one public channel by a link (server, web)

- [server] Visitor links (`POST`/`GET /v1/channels/:id/visitor-links`, `DELETE /v1/visitor-links/:id`, 24 hours) and the public `GET`/`POST /v1/visit/:token` (preview, join with Turnstile when `TURNSTILE_SECRET` is set; rate limited); migration `0011_chat_visitors`.
- [server] A visitor's own routes `/v1/visitor/*` and socket, by the HttpOnly `vsid` cookie (`<org id>.<random>`): messages, threads, reactions, files, leave; every read and live event cut to what was posted after they joined.
- [server] Visitors never ask an agent; agent and group mentions in their messages become plain text. `visitor: true` on their messages; `visitors` policy (on by default; off removes everyone); daily sweep after 30 idle days.
- [bridge] Never answers a message with `visitor: true` (0.39.1).
- [web] The visitor's page at `/chat/visit/<token>`: name screen with Turnstile, then Chat's own message list, threads and composer on a `VisitorRuntime` that maps them to `/v1/visitor/*`, with the visitor socket; Leave.
- [web] Invite a visitor in a public channel's ⋯ menu (link, Copy, open links with Turn off); a Visitors section with Remove in the channel's people; a Visitor label on visitors' messages and mentions.
- [web] Admin › General: "Visitors in channels" switch.

## Feature

- **Invite a visitor to a channel.** Anyone in a public channel can make a link that lets someone with no account into just that channel. The link works for a day. They type their name and can read and post, but see only what is posted after they join. Visitors are labelled, and anyone can remove them from the channel's people list. Admins can turn visitors off in Admin › General.
