# Workspace onboarding: Welcome page, setup steps and a new sign-in

- `[server]` `[web]` Signed-out `/` shows the Welcome page; `/home/setup` walks a new person through workspace, domain (own domain only, skippable), email & calendar (skippable), Chief of Staff, Omni, team and automations (docs/specs/onboarding.md).
- `[server]` Setup state per person (`/v1/workspaces/:id/setup`), marked when a new member's assistant is made; existing members are never marked.
- `[server]` Omni (`/v1/workspaces/:id/team-agent`): a hosted shared agent that joins every public channel, now and as they are made. Admin › Agents can add it later.
- `[server]` A person's own assistant gets `create_subscription`, `list_subscriptions` and `list_jobs`, run as the person; setup's plain-language automations use them.
- `[server]` Schedules take `weekdays@HH:MM`, used by the ready-made Daily Briefing.
- `[web]` Mail's and Calendar's add-account forms moved to `@flow/suite-bar/link-accounts`, shared with setup's Email & calendar step.
- `[web]` Admin › Domains' domain card moved to `@flow/suite-bar/domain-setup`, shared with setup's Domain step.
- `[server]` `[web]` Email codes (`/v1/auth/code`, `/code/verify`): one 6-digit code logs in an account or starts a sign-up; Chat's sign-in screen restyled to the new design (password login first).
- `[server]` `[web]` The sign-in screen lives at `/login` and `/signup`; sign-in redirects and emailed links go there, and `/chat` signed out shows `/login`.
- `[web]` Chat sends a person with no workspace to setup instead of the chooser; `connectPrompt` moved to `@flow/shared/assistant`.

## Feature

- **A guided start.** New visitors see what FreeFlow is, then set up a workspace in a few short steps: name it (and connect your own domain, now or later), link the email and calendar you already use, meet and name your Chief of Staff, add Omni, invite your team and agents, and turn on automations.
- **Omni, your team's shared agent.** Omni joins every public channel and answers anyone from what the team shares with it.
- **Automations in your own words.** Write when something should happen and what to do; your Chief of Staff sets it up. Daily Briefing and Meeting Prep are ready for you from the start.
- **A new sign-in page.** Log in with your password as before, or ask for a 6-digit code by email. New here? Create an account with any email, then pick your name and password.
