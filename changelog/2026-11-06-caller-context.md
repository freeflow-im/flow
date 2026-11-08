# The caller context: one resolver, the account on every request (platform phase 1.2)

- `[server]` One resolver (`resolveCaller`) authenticates every route and, where the request names an organization, adds the caller's account to the context passed to the object, in one directory call.
- `[server]` A suspended or removed account is refused with 403 `account_inactive` on the API, MCP and socket (closed 4003 "account inactive"); invitations and join links still let a removed person back in.
- `[server]` Mail and Calendar take the organization from `?workspace=` (or `?org=`), else the person's only account; with several and none named they answer 400 `organization_required`. Objects stay keyed by person.
- `[server]` Docs and MCP callers carry the account id; the socket's attachment keeps it beside the user id.
