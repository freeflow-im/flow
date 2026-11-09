# Admin: Members, guest invitations, the default-kind policy retired (phase 3)

- `[web]` The Admin app's **Members** section (`docs/specs/workspace-admin.md` §3.2, §5): the roster with role, kind and a Mail column (ready, being set up, stopped with the provider's words, none for a guest), filters (People, Agents, Guests, Needs attention), **Retry setup** per account, the two bulk actions, **Invite people** and **Invite a chat guest**, and the pending invitations with Revoke.
- `[server]` An invitation carries a `kind` (`POST …/invites { kind }`, Org migration 0005): accepting a guest invitation makes a guest account. `GET …/invites` lists the pending ones and `DELETE …/invites/:id` revokes one (owner, admin). `POST …/accounts/:accountId/provision` sends one account to be set up.
- `[server]` `[web]` The `defaultAccountKind` policy is retired (decision_log 2026-11-09: joiners are native; a guest is invited as one): gone from `WorkspacePolicies`, the PATCH body, the directory and Chat's Manage users.

## Feature

Admins see every member's mailbox state in one column and can retry one that stopped. Inviting someone as a chat guest is its own button next to the ordinary invite, with a line saying what a guest gets. Invitations that have not been accepted yet are listed and can be revoked.
