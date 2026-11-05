export type TenantScope = Readonly<{ organizationId: string }>;

/** Accepts only the trusted organization context selected by the authentication boundary. */
export function requireTenantScope(scope: TenantScope): TenantScope {
  if (!scope || typeof scope.organizationId !== 'string' || scope.organizationId.trim().length === 0) {
    throw new TypeError('A non-empty organization scope is required.');
  }
  return scope;
}
