# Organizations: owner, policies, transfer, and the address on every member (platform phase 1.3)

- `[server]` A join asks the directory for the account first (`ensureAccount`), so each member row carries its address; members get `address`, `GET /v1/me/workspaces` the caller's own. Older rows are backfilled from the directory once.
- `[server]` Workspace `policies` (`inviteBy`, `agentsBy`, `linkSharing`), set by the workspace PATCH and mirrored to the directory; `admins` refuses members' invites, join links and agent invites with 403 `policy_forbids`. Default `members` now lets members invite.
- `[server]` `POST /v1/workspaces/:id/owner` hands the organization to another person (caller becomes admin); role changes and the new owner now reach the directory.
- `[web]` Addresses on Directory cards, the profile card and Settings; Manage users gains an Organization section with the owner, the policies and Transfer ownership.

## Feature

- **See everyone's address.** Each member's address in the organization now shows in the Directory and on their profile.
- **Decide who can invite and add agents.** An organization's owners and admins can choose whether every member or only admins may invite people and add agents.
- **Hand the organization on.** The owner can transfer ownership to another member and stay on as an admin.
