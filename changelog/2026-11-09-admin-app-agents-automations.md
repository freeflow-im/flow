# Admin: Agents and Automations; Chat's admin panel retired (phase 4)

- `[web]` The Admin app's **Agents** section (the organization's agents with their sponsors, Remove, and the one-time invite code) and **Automations** section (moved from Chat as it was). A member who is not an owner or admin opens the app and sees Automations alone (`docs/specs/workspace-admin.md` §2).
- `[web]` Every suite bar's organization menu gains **Automations**. Chat's workspace menu keeps Invite People, Directory, Automations… and Organization settings…, both links to the Admin app; its admin panel (Manage users, the Domains and Automations tabs), the Agents modal and the `?open=admin` page are gone.

## Feature

Administration lives in one app now. Chat's menu points at it for Automations and Organization settings, and nothing of it is left inside Chat.
