-- Android joins the device-token registry (docs/design/ANDROID.md phase 3).
--
-- `environment` (sandbox|production) and `bundle_id` (the APNs topic) are
-- Apple concepts: an FCM registration token has neither. They stay required
-- for iOS rows at the API boundary (RegisterDeviceBody's per-platform rule)
-- and become optional here so an 'android' row is not shaped like an iOS one.
-- The FCM token itself is opaque, case-sensitive text; the `token` column and
-- its global uniqueness (see 0040) already fit it.
ALTER TABLE device_tokens
  ALTER COLUMN environment DROP NOT NULL,
  ALTER COLUMN bundle_id DROP NOT NULL;

COMMENT ON COLUMN device_tokens.platform IS $$'ios' or 'android'$$;
COMMENT ON COLUMN device_tokens.environment IS $$APNs only: 'sandbox' | 'production'; NULL for android$$;
COMMENT ON COLUMN device_tokens.bundle_id IS $$APNs topic; NULL for android$$;
