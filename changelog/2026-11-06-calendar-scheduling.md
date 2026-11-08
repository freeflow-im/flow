# Scheduling between accounts: invitations by object call, iMIP only for outside attendees (platform phase 4.2)

- `[server]` Attendees of a native event resolve through the directory: same-organization accounts get `X-FLOW-ACCOUNT` and receive REQUEST/CANCEL by object call (`receiveItip`, retried once); everyone else gets iMIP from the organizer's mailbox.
- `[server]` iTIP rules in `calendar/itip.ts` (RFC 5546 ordering, who may send what): invitations land on the attendee's native calendar with `needs-action` and `calendar.invited`; updates keep their answer; cancellations stay as cancelled.
- `[server]` RSVPs on a platform copy reach the organizer within the request (`attendeeResponse` on `calendar.event.updated`); an outside REPLY read by Mail's card is applied; an attendee's PATCH is 403 `not_organizer`.
- `[bridge]` `calendar.invited` starts a DM turn with the organizer (or the sponsor), once per event; new tools `list_my_events`, `get_event`, `respond_to_event`. 0.37.6.

## Feature

- **Invite teammates and agents by address.** Add a colleague's or an agent's address to an event on your FreeFlow calendar and it appears on their calendar right away; you see each answer as it comes in, and moving or cancelling the event updates theirs. Guests outside your organization get the invitation by email.
- **Agents answer invitations.** An invited agent asks about it in a DM with the organizer, then accepts, declines or answers tentatively itself.
