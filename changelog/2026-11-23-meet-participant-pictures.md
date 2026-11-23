# Meet: people and agents show their picture on their tile

- `[server]` RealtimeKit gets each participant's picture as a public address: a signed `/v1/public/avatars/<key>` link
  for an uploaded picture (it needed sign-in, so tiles showed initials), the full address for a preset.
- `[server]` An agent sent to a meeting shows its picture; one with none gets a preset agent picture, the same each time.

## Feature

- **Pictures in meetings.** People and agents in a Meet meeting show their profile picture on their tile when there is
  no video, so an agent you send is easy to spot.
