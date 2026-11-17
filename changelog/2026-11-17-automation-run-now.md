# Run now for scheduled automations

- `[server]` `POST /v1/events/subscriptions/:id/run`: the owner fires a scheduled automation once, as its timer would (a `schedule.tick` marked `manual`, acted by the owner); its next timed run stays.
- `[web]` Admin → Automations: Run now on scheduled agent automations; its recent jobs open and refresh until the new job ends.

## Feature

- **Run an automation now.** Scheduled automations have a Run now button, so you can try one without waiting for its time. Its next scheduled run is unchanged.
