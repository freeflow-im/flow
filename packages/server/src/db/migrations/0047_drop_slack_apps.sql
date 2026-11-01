-- The Slack-compatible API (phase 4: bots with xoxb-/xapp- tokens, the Events
-- API outbox, Socket Mode) is removed ahead of the FreeFlow suite merge
-- (docs/specs/freeflow-suite.md §2.0, decision_log 2026-11-01). Its tables go.
--
-- The bot users those apps owned stay as user rows: their messages reference
-- them, and dropping the rows would take channel history with them. They are
-- tombstoned and removed from their workspaces instead, so they leave member
-- lists and directories the way a departed person does; `users.is_bot` keeps
-- its meaning ("not a person") for those rows.
DROP TABLE IF EXISTS app_socket_tickets;
DROP TABLE IF EXISTS pending_app_events;
DROP TABLE IF EXISTS apps;

DELETE FROM workspace_members WHERE user_id IN (SELECT id FROM users WHERE is_bot);
UPDATE users SET deleted_at = now() WHERE is_bot AND deleted_at IS NULL;
