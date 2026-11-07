# Docs on grants: share with a person, a channel, the organization or a link (platform phase 3.2)

- `[server]` Docs authorizes every file and folder through `@flow/shared/grants` (`docs/server/access.ts`): owner column, then the grants of the object and its folders; read needs viewer, change editor, sharing manager, delete and Move to organization… owner.
- `[server]` One-time migration: shared rows get an `org` editor grant, public links become `link:` viewer grants (`public_links` kept unread one release); `private` stays as the derived flag.
- `[server]` `GET/PUT/DELETE /api/grants/:kind/:id[/:principal]`, `POST …/link` (refused with `policy_forbids` under `linkSharing: false`); `/api/sharing/*` wrap the link grant; `/api/library?scope=shared` lists Shared with me.
- `[server]` The Worker passes the caller's channels (`Org.channelIdsOf`) to Docs, and indexes link tokens so a guest's `/api/public/<token>` finds its organization.
- `[web]` Share… on every file and folder menu (people, agents, channels, the organization, the link), a Shared with me list, and editors read-only for viewers.

## Feature

- **Share a file or folder with someone.** Choose Share… on any file or folder to give a person, an agent or a channel view, edit or share access, share it with the whole organization, or make a link anyone can open. A file in a shared folder is shared too.
- **Shared with me.** Files and folders others share with you have their own list beside My files and Organization files. Files you can only view open read-only.
