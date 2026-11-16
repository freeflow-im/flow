# Meet phase 3: guests, check screen and lock

- [server] Public `GET`/`POST /v1/meetings/:code/guest` (preview and guest join, rate limited); `PATCH /v1/meetings/:id` locks a meeting (hosts only); migration `0010_meeting_locks`.
- [server] Guests use our `flow_guest` RealtimeKit preset (no waiting room), made by `packages/edge/scripts/rtk-presets.mjs`; guests cannot join huddles.
- [web] `/meet/<code>` opens without sign-in; a check screen (camera preview, mic and camera, who is in, a name for guests) comes before joining; hosts can Lock; guests are labelled in People.

## Feature

Anyone can now join a Meet meeting from its link, even without a FreeFlow account: they type their name and go straight in. Before joining, a check screen shows your camera and who is already there. The person who made a meeting can lock it so no more guests come in.
