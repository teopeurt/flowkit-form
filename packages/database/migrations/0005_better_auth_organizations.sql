CREATE SCHEMA IF NOT EXISTS better_auth;

CREATE TABLE better_auth."user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE better_auth.account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES better_auth."user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT better_auth_account_provider_account_unique UNIQUE (provider_id, account_id)
);

CREATE INDEX better_auth_account_user_idx ON better_auth.account(user_id);

CREATE TABLE better_auth.session (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES better_auth."user"(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  active_organization_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX better_auth_session_user_idx ON better_auth.session(user_id);

CREATE TABLE better_auth.verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX better_auth_verification_identifier_idx ON better_auth.verification(identifier);

CREATE TABLE better_auth.organization (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo text,
  metadata text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE better_auth.member (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES better_auth."user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  application_role text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT better_auth_member_organization_user_unique UNIQUE (organization_id, user_id)
);

CREATE INDEX better_auth_member_user_idx ON better_auth.member(user_id);

CREATE TABLE better_auth.invitation (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  inviter_id text NOT NULL REFERENCES better_auth."user"(id) ON DELETE CASCADE
);

CREATE INDEX better_auth_invitation_email_idx ON better_auth.invitation(email);
CREATE INDEX better_auth_invitation_organization_idx ON better_auth.invitation(organization_id);
