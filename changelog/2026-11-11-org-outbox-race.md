# Org outbox: no lost changes; reconcile accounts

- `[server]` The Org object flushes its outbox to the directory one batch at a time and deletes only the rows it sent. Overlapping flushes could delete a change never sent (the emptied table reuses `seq`); two of 54 guest removals in Locked In were lost this way.
- `[server]` `POST /v1/workspaces/:id/accounts/reconcile` (admins): lists directory accounts whose principal is no longer an Org member, or a personal agent whose sponsor is not; `?apply=1` removes them.
- `[qa]` `e2e-admin.mjs`: removing a member takes their account and assistant out of the directory; reconcile finds nothing left.
