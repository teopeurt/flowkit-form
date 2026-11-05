import {
  boolean,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const betterAuth = pgSchema('better_auth');

export const user = betterAuth.table('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const account = betterAuth.table('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true, mode: 'date' }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true, mode: 'date' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  unique('better_auth_account_provider_account_unique').on(table.providerId, table.accountId),
  index('better_auth_account_user_idx').on(table.userId),
]);

export const session = betterAuth.table('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  activeOrganizationId: text('active_organization_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('better_auth_session_user_idx').on(table.userId)]);

export const verification = betterAuth.table('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('better_auth_verification_identifier_idx').on(table.identifier)]);

export const organization = betterAuth.table('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const member = betterAuth.table('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  applicationRole: text('application_role').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  unique('better_auth_member_organization_user_unique').on(table.organizationId, table.userId),
  index('better_auth_member_user_idx').on(table.userId),
]);

export const invitation = betterAuth.table('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull(),
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  inviterId: text('inviter_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, (table) => [
  index('better_auth_invitation_email_idx').on(table.email),
  index('better_auth_invitation_organization_idx').on(table.organizationId),
]);

export const betterAuthSchema = {
  user,
  account,
  session,
  verification,
  organization,
  member,
  invitation,
};
