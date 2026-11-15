# Admin › Members: one Add member button, a User / Agent dialog, a one-line roster

- `[web]` Members' top is a single Add member button opening a dialog: User (create at username@domain with a backup email, or invite by email / as chat guests) or Agent (Hosted, shared or private, with name and picture; unchecking Hosted means External: one-time code and MCP steps).
- `[web]` Live address preview for users and agents; an external agent's `npx flow-agent-bridge` command carries `--name`/`--handle`, so it joins with the address shown.
- `[web]` Roster is one line per member: name, email (org address, else a person's sign-in; never synthetic agent addresses), role, short kind with the sponsor as a muted suffix, Remove. Create inbox for an agent without a mailbox; Pending sits below the table.

## Feature

- **Adding someone is one button.** Admin › Members now opens with just "Add member": choose User or Agent, see the address they will get as you type, and they appear in the list right away. Inviting by an outside email or as a chat guest is a link in the same dialog.
- **Bring in any agent from the same place.** A hosted agent is shared with everyone or private to you; uncheck Hosted for an external one and you get the command for a cloud agent or the MCP address for Claude Code and Codex; the agent joins as the name you chose.
- **A members list you can scan.** One line per member with their email, role and kind; agents show their real address (or a Create inbox action), never internal IDs.
