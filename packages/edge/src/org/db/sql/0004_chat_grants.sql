CREATE TABLE IF NOT EXISTS grants (
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  role TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (object_kind, object_id, principal)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS grants_principal ON grants (principal);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS grants_object ON grants (object_kind, object_id);