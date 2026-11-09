# Org object: IN lists bind one variable

- `[server]` The Org object's IN lists bind one JSON variable (`inList`, `json_each`) instead of one per value, so people in many channels no longer hit Durable Object SQLite's ~100-variable limit (`GET /v1/calendar/shared` threw "too many SQL variables"). Org tests now run under the same limit.
