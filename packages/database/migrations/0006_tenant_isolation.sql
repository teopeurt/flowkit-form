-- All tenant-owned rows carry a mandatory FK to the BetterAuth organization.
-- The demo database is disposable; this migration intentionally rejects legacy populated tables
-- instead of guessing an organization for pre-tenant data.
ALTER TABLE users ADD COLUMN organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE;
ALTER TABLE leave_requests ADD COLUMN organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE;
ALTER TABLE leave_transitions ADD COLUMN organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE;
ALTER TABLE flow_tasks ADD COLUMN organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE;
ALTER TABLE flow_task_events ADD COLUMN organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE;
ALTER TABLE flow_task_projection_operations ADD COLUMN organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE;
ALTER TABLE flow_task_invitations ADD COLUMN organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE;
ALTER TABLE notification_outbox ADD COLUMN organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE;
ALTER TABLE notification_inbox ADD COLUMN organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE;
ALTER TABLE audit_events ADD COLUMN organization_id text NOT NULL REFERENCES better_auth.organization(id) ON DELETE CASCADE;

ALTER TABLE users ADD CONSTRAINT users_organization_id_unique UNIQUE (organization_id, id);
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_organization_id_unique UNIQUE (organization_id, id);
ALTER TABLE flow_tasks ADD CONSTRAINT flow_tasks_organization_id_unique UNIQUE (organization_id, id);
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_organization_employee_fk
  FOREIGN KEY (organization_id, employee_id) REFERENCES users (organization_id, id);
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_organization_manager_fk
  FOREIGN KEY (organization_id, manager_id) REFERENCES users (organization_id, id);
ALTER TABLE leave_transitions ADD CONSTRAINT leave_transitions_organization_leave_fk
  FOREIGN KEY (organization_id, leave_id) REFERENCES leave_requests (organization_id, id) ON DELETE CASCADE;
ALTER TABLE flow_task_events ADD CONSTRAINT flow_task_events_organization_task_fk
  FOREIGN KEY (organization_id, task_id) REFERENCES flow_tasks (organization_id, id) ON DELETE CASCADE;
ALTER TABLE flow_task_invitations ADD CONSTRAINT flow_task_invitations_organization_task_fk
  FOREIGN KEY (organization_id, task_id) REFERENCES flow_tasks (organization_id, id) ON DELETE CASCADE;

ALTER TABLE users DROP CONSTRAINT users_email_key;
ALTER TABLE users ADD CONSTRAINT users_organization_email_unique UNIQUE (organization_id, email);
ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_operation_key_key;
ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_flow_id_key;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_organization_operation_unique UNIQUE (organization_id, operation_key);
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_organization_flow_unique UNIQUE (organization_id, flow_id);
DROP INDEX leave_transition_operation_key_idx;
ALTER TABLE leave_transitions DROP CONSTRAINT leave_transitions_operation_key_key;
ALTER TABLE leave_transitions DROP CONSTRAINT leave_transitions_leave_id_sequence_key;
ALTER TABLE leave_transitions ADD CONSTRAINT leave_transitions_organization_operation_unique UNIQUE (organization_id, operation_key);
ALTER TABLE leave_transitions ADD CONSTRAINT leave_transitions_organization_leave_sequence_unique UNIQUE (organization_id, leave_id, sequence);
ALTER TABLE flow_tasks DROP CONSTRAINT flow_tasks_opened_operation_key_key;
ALTER TABLE flow_tasks ADD CONSTRAINT flow_tasks_organization_opened_operation_unique UNIQUE (organization_id, opened_operation_key);
ALTER TABLE flow_task_events DROP CONSTRAINT flow_task_events_task_id_sequence_key;
ALTER TABLE flow_task_events ADD CONSTRAINT flow_task_events_organization_task_sequence_unique UNIQUE (organization_id, task_id, sequence);
ALTER TABLE flow_task_projection_operations DROP CONSTRAINT flow_task_projection_operations_pkey;
ALTER TABLE flow_task_projection_operations ADD PRIMARY KEY (organization_id, operation_key);
ALTER TABLE flow_task_invitations DROP CONSTRAINT flow_task_invitations_token_hash_key;
ALTER TABLE flow_task_invitations DROP CONSTRAINT flow_task_invitations_source_key_key;
ALTER TABLE flow_task_invitations ADD CONSTRAINT flow_task_invitations_organization_token_unique UNIQUE (organization_id, token_hash);
ALTER TABLE flow_task_invitations ADD CONSTRAINT flow_task_invitations_organization_source_unique UNIQUE (organization_id, source_key);
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_dedupe_key_key;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_organization_dedupe_unique UNIQUE (organization_id, dedupe_key);
ALTER TABLE notification_inbox DROP CONSTRAINT notification_inbox_dedupe_key_key;
ALTER TABLE notification_inbox ADD CONSTRAINT notification_inbox_organization_dedupe_unique UNIQUE (organization_id, dedupe_key);

CREATE INDEX users_organization_idx ON users (organization_id, id);
CREATE INDEX leave_requests_organization_idx ON leave_requests (organization_id, id);
CREATE INDEX leave_transitions_organization_leave_idx ON leave_transitions (organization_id, leave_id, sequence);
CREATE INDEX flow_tasks_organization_inbox_idx ON flow_tasks (organization_id, status, role_key, id);
CREATE INDEX flow_task_events_organization_task_idx ON flow_task_events (organization_id, task_id, sequence);
CREATE INDEX notification_outbox_organization_due_idx ON notification_outbox (organization_id, status, available_at);
CREATE INDEX notification_inbox_organization_user_delivery_idx ON notification_inbox (organization_id, user_id, delivered_at DESC, id DESC);
CREATE INDEX audit_events_organization_entity_idx ON audit_events (organization_id, entity_id, created_at);
