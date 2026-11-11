# Guests have no assistant

- `[server]` A guest account gets no assistant: none is made at join or by the backfill. A member made a guest has theirs set aside (its account removed, the principal kept); made a member again, the same assistant comes back. Guests' assistants made by the phase C deploy are set aside once at the directory's next start. `GET /api/agent/agents` refuses a guest.
