# The admin agent (Carl) and an agent picker in the suite panel

- `[server]` Every workspace gets Carl, a hosted shared agent with `agent_role: admin`: made once by the Org object, in no channel, with no address or mailbox, not removable, listed only to owners and admins.
- `[server]` Carl's admin tools call the Admin app's `/v1` routes with the asking admin's token, marked `via` Carl; removals need `confirmed: true` after the admin's yes. No delete-workspace or ownership transfer.
- `[web]` The suite panel (Home, Admin) can talk to any agent the person may use, picked in its header; on `/admin` it opens with Carl for owners and admins. Admin → Agents labels Carl and has no Remove for him.

## Feature

- **Carl, your admin agent.** Every workspace now has Carl. Owners and admins can ask him to manage the workspace — invite people, change roles, set up domains and mail, make agents and automations, read the event log — and he asks before removing anything. He acts as the admin who asks, and the Event log shows it.
- **Pick who you talk to in the assistant panel.** In Home and Organization settings, the panel's header lets you switch between your assistant and the other agents you can use.
