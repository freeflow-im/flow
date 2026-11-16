# Meet phase 3: guests, check screen, lock, Calendar and booking page

- [server] Public `GET`/`POST /v1/meetings/:code/guest` (preview and guest join, rate limited); `PATCH /v1/meetings/:id` locks a meeting (hosts only); migration `0010_meeting_locks`.
- [server] Guests use our `flow_guest` RealtimeKit preset (no waiting room), made by `packages/edge/scripts/rtk-presets.mjs`; guests cannot join huddles.
- [web] `/meet/<code>` opens without sign-in; a check screen (camera preview, mic and camera, who is in, a name for guests) comes before joining; hosts can Lock; guests are labelled in People.
- [web] Calendar: "Add FreeFlow Meet" in the event editor writes a `Join with FreeFlow Meet:` line, which the event card reads as its Join button.
- [server] [web] Booking page location "FreeFlow Meet": each booking gets its own meeting (made by the owner's organization), kept when it is moved.
- [web] Home: the Today card has Join for an event's video call.

## Feature

Anyone can now join a Meet meeting from its link, even without a FreeFlow account: they type their name and go straight in. Before joining, a check screen shows your camera and who is already there. The person who made a meeting can lock it so no more guests come in.

In Calendar, "Add FreeFlow Meet" puts a meeting link on an event, and the event has a Join button. Your booking page can use FreeFlow Meet as its location, so each booking gets its own meeting link. Home's Today card has a Join button for your calls.
