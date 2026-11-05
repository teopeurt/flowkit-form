import { hashPassword } from 'better-auth/crypto';

import { loadConfig } from '@flowkit-demo/domain';
import { withMigrationClient } from '../src/client';
import { assertDisposableLocalDatabase } from '../../../scripts/lib/local-database-guard';

const config = loadConfig();
if (!config.FLOWKIT_DEMO_ALLOW_SEED || !['development', 'test'].includes(config.NODE_ENV)) {
  throw new Error('Demo seed requires development/test and FLOWKIT_DEMO_ALLOW_SEED=true');
}

const organizations = [
  { id: 'acme-demo', name: 'Acme Demo', slug: 'acme-demo' },
  { id: 'globex-demo', name: 'Globex Demo', slug: 'globex-demo' },
] as const;
const roles = [
  { key: 'employee', readonly: false },
  { key: 'manager', readonly: false },
  { key: 'hr', readonly: false },
  { key: 'readonly_auditor', readonly: true },
] as const;
const passwordByOrganization = {
  'acme-demo': 'Acme-Demo-Only-2026!',
  'globex-demo': 'Globex-Demo-Only-2026!',
} as const;
const identities = organizations.flatMap((organization) => roles.map((role) => ({
  organizationId: organization.id,
  id: `${organization.id}-${role.key}`,
  name: `${organization.name} ${role.key.replace('_', ' ')}`,
  email: `${role.key.replace('_', '-')}@${organization.slug}.example.test`,
  role: role.key,
  password: passwordByOrganization[organization.id],
})));

const passwordHashes = new Map<string, string>();
for (const organization of organizations) {
  passwordHashes.set(organization.id, await hashPassword(passwordByOrganization[organization.id]));
}

await withMigrationClient(async (client) => {
  await client.begin(async (tx) => {
    for (const organization of organizations) {
      await tx`
        INSERT INTO better_auth.organization (id, name, slug)
        VALUES (${organization.id}, ${organization.name}, ${organization.slug})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug
      `;
    }
    for (const role of roles) {
      await tx`
        INSERT INTO roles (role_key, readonly) VALUES (${role.key}, ${role.readonly})
        ON CONFLICT (role_key) DO UPDATE SET readonly = EXCLUDED.readonly
      `;
    }
    for (const identity of identities) {
      await tx`
        INSERT INTO better_auth."user" (id, name, email, email_verified)
        VALUES (${identity.id}, ${identity.name}, ${identity.email}, true)
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, email = EXCLUDED.email, email_verified = true, updated_at = now()
      `;
      await tx`
        INSERT INTO better_auth.account (id, account_id, provider_id, user_id, password)
        VALUES (${`credential-${identity.id}`}, ${identity.id}, 'credential', ${identity.id}, ${passwordHashes.get(identity.organizationId)!})
        ON CONFLICT (provider_id, account_id) DO UPDATE SET password = EXCLUDED.password, updated_at = now()
      `;
      await tx`
        INSERT INTO better_auth.member (id, organization_id, user_id, role, application_role, enabled)
        VALUES (${`member-${identity.id}`}, ${identity.organizationId}, ${identity.id}, 'member', ${identity.role}, true)
        ON CONFLICT (organization_id, user_id) DO UPDATE
        SET application_role = EXCLUDED.application_role, enabled = true
      `;
      await tx`
        INSERT INTO users (organization_id, id, email, role_key)
        VALUES (${identity.organizationId}, ${identity.id}, ${identity.email}, ${identity.role})
        ON CONFLICT (id) DO UPDATE
        SET organization_id = EXCLUDED.organization_id, email = EXCLUDED.email, role_key = EXCLUDED.role_key
      `;
    }
  });
});

if (config.NODE_ENV === 'development') {
  await assertDisposableLocalDatabase({ databaseUrl: config.DATABASE_URL });
  process.stdout.write('Seeded two isolated demo organizations. Local development credentials:\n');
  for (const identity of identities) {
    process.stdout.write(`  ${identity.email} / ${identity.password}\n`);
  }
} else {
  process.stdout.write('Seeded two isolated demo organizations.\n');
}
