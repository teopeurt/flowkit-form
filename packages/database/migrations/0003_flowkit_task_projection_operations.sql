CREATE TABLE IF NOT EXISTS flow_task_projection_operations (
  operation_key text PRIMARY KEY,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flow_task_invitations (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES flow_tasks(id),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  role_key text NOT NULL,
  contact_kind text NOT NULL CHECK (contact_kind IN ('email', 'phone')),
  contact_hash text NOT NULL,
  contact_hash_key_version text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  source_key text NOT NULL UNIQUE,
  accepted_identity_id text,
  accepted_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'
);
