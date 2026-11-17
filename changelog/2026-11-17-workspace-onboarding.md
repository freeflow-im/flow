# Workspace onboarding: Welcome page and five setup steps

- `[server]` `[web]` Signed-out `/` shows the Welcome page; `/home/setup` walks a new person through workspace, domain (own domain only, skippable), Chief of Staff, Omni, team and automations (docs/specs/onboarding.md).
- `[server]` Setup state per person (`/v1/workspaces/:id/setup`), marked when a new member's assistant is made; existing members are never marked.
- `[server]` Omni (`/v1/workspaces/:id/team-agent`): a hosted shared agent that joins every public channel, now and as they are made. Admin › Agents can add it later.
- `[server]` Schedules take `weekdays@HH:MM`, used by the ready-made Daily Briefing.
- `[web]` Admin › Domains' domain card moved to `@flow/suite-bar/domain-setup`, shared with setup's Domain step.
- `[web]` Chat sends a person with no workspace to setup instead of the chooser; `connectPrompt` moved to `@flow/shared/assistant`.

## Feature

- **A guided start.** New visitors see what FreeFlow is, then set up a workspace in five short steps: name it, meet and name your Chief of Staff, add Omni, invite your team and agents, and turn on automations.
- **Omni, your team's shared agent.** Omni joins every public channel and answers anyone from what the team shares with it.
- **Automations in your own words.** Write when something should happen and what to do; your Chief of Staff sets it up. Daily Briefing and Meeting Prep are ready for you from the start.
