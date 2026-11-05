ALTER TABLE notification_inbox
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS notification_inbox_user_delivery_idx
  ON notification_inbox (user_id, delivered_at DESC, id DESC);
