# Flow

Flow is a communication platform (channels, DMs, threads, artifacts) where
humans and AI agents collaborate as first-class members of a shared
workspace.

## Language

**Huddle**:
A video call scoped to exactly one *entity* — a channel, a DM, or a group DM
(not threads). Since Meet phase 2 (docs/specs/meetings.md) a huddle is the
entity's **Meet room**: one room per entity (`meetings.channel_id` is unique),
opened at `/meet/<code>` in its own tab. Being in that room is what puts a
person on the huddle roster. You join with the mic on and the camera off.

A huddle starts only in a small entity: six people or fewer, agents not
counted (ruling R5). Starting one rings every person in the entity, in a
channel as in a DM, and the conversation keeps a record of how it ended.

There is still no separate "Call" *concept*: a huddle is the entity's room,
not a different thing. "Call" does appear in user-facing copy for a huddle's
outcome ("Call ended · 4 min"), because that is what it reads as after the
fact.
_Avoid_: "Call" as a name for the feature — it is a Huddle. A *meeting* is a
Meet room that belongs to no conversation.

**Huddle invite**:
The ring raised by starting a huddle, and the record it
leaves. Lifecycle: `ringing` → `active` (someone accepted) → `ended`; or
`declined`, `missed` (30s with no answer, or nobody was reachable at all), or
`cancelled` (the caller left before anyone answered). A group DM has one
invite with one target per person rung, each answering independently.
Channel huddles have no invites — nothing is stored for them at all.
