# Chat visitors, phase 1 (server): one public channel by a link

- [server] Visitor links (`POST`/`GET /v1/channels/:id/visitor-links`, `DELETE /v1/visitor-links/:id`, 24 hours) and the public `GET`/`POST /v1/visit/:token` (preview, join with Turnstile when `TURNSTILE_SECRET` is set; rate limited); migration `0011_chat_visitors`.
- [server] A visitor's own routes `/v1/visitor/*` and socket, by the HttpOnly `vsid` cookie (`<org id>.<random>`): messages, threads, reactions, files, leave; every read and live event cut to what was posted after they joined.
- [server] Visitors never ask an agent; agent and group mentions in their messages become plain text. `visitor: true` on their messages; `visitors` policy (on by default; off removes everyone); daily sweep after 30 idle days.
- [bridge] Never answers a message with `visitor: true` (0.39.1).
