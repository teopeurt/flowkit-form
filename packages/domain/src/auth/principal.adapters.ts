import { freezePrincipal, type AuthenticatedPrincipal } from '@naakwu/flowkit-auth';
import type { FlowkitActorRef } from '@naakwu/flowkit-consumer';
import { roleRegistry } from './role-registry';

const canonicalRoles = {
  'employee-1': 'employee',
  'manager-1': 'manager',
  'manager-2': 'manager',
  'hr-1': 'hr',
  'auditor-1': 'readonly_auditor',
  system: 'system',
} as const satisfies Record<string, keyof typeof roleRegistry.definitions>;

export function principal(id: string, role: keyof typeof roleRegistry.definitions): AuthenticatedPrincipal {
  return freezePrincipal({ authUserId: id, subjectId: id, role, permissions: roleRegistry.definitions[role].permissions, readOnly: roleRegistry.isReadOnly(role), identityProofs: [], session: { id: `session-${id}`, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() } });
}

/** Resolves only the seeded workflow identities; HTTP authentication never calls this adapter. */
export async function resolveDemoActor(id: string): Promise<FlowkitActorRef> {
  const seeded = /^(acme-demo|globex-demo)-(employee|manager|hr|readonly_auditor)$/.exec(id);
  const role = seeded?.[2] as keyof typeof roleRegistry.definitions | undefined
    ?? canonicalRoles[id as keyof typeof canonicalRoles];
  if (!role) throw new Error('actor_not_found');
  return { id, roles: [role], ...(seeded ? { organizationId: seeded[1] } : {}) };
}
