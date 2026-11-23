# Meet recording to Docs › Meetings (Meet phase 4, Taskboard task 28)

- `[server]` `POST`/`DELETE /v1/meetings/:id/recording`: any member in the room starts or stops RTK's recording; transcribing is turned on with it and off after.
- `[server]` RTK's `recording.statusUpdate` and `meeting.transcript` webhooks are noted; the Org alarm copies the video (streamed, never held in memory) and a Markdown transcript to `Meetings/<date> <title>/` in Organization files, owned by the recorder, and links each in the meeting's chat.
- `[web]` `[desktop]` Meet room: Record button for members, a recording badge for everyone from RTK's own state.
- Operator: the prod RTK webhook must also send `recording.statusUpdate` and `meeting.transcript`.

## Feature

- **Record a meeting.** Anyone from your organization in a Meet call can press Record. Everyone sees that it is recording. When the meeting ends, the video and a transcript with who said what are saved in Docs, in the Meetings folder of your organization's files, and linked in the meeting's chat.
