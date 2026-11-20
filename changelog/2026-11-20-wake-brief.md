# Automations tell the woken agent which event fired

- `[server]` A wake job's `agent.job` prompt is now a brief: the automation's name, the event that fired it (type, object, actor, channel, data; a schedule's run time) and the prompt, to act on for that one event. The job row keeps the raw prompt. Hosted runtimes run the same brief; bridges get it with no release.

## Feature

- **Agents woken by an automation know why.** The agent is told which automation woke it and which event fired it, so it acts on that one event instead of setting up its own checks.
