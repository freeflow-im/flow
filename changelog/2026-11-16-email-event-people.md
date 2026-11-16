# Calendar: email someone on an event

- [web] A mail icon by each guest and the organizer on an event opens a new email to them, subject the event's title: in a drawer beside Calendar (Mail's composer, `/mail/compose`), or in Mail's own composer when Calendar is Mail's side panel.
- [web] Mail opens its composer from `?mailto=` (`createAddress('mail')` in @flow/shared).

## Feature

- On a calendar event, click the mail icon next to a guest or the organizer to write them an email. It opens beside your calendar, so you don't lose your place.
