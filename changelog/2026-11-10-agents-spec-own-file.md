# Agents spec moved to its own file

- `[qa]` `docs/specs/agents.md` holds the agent model (personal and shared agents, accounts, runtimes, the panel, browser tools), what the code does today, and a three-phase build plan (A agents by account, B connecting an external agent, C hosted agents). `platform.md` §2.3, §3.3, §5.5, §9 and §11 keep a summary and point there. Spec only, no code.
- `[qa]` Ruling 2026-11-10: kind and runtime (hosted or external) are two axes; the assistant is the person's hosted personal agent, not a special case; hosted agents have a definition; sync and async are properties of the turn. In `decision_log.md`.
