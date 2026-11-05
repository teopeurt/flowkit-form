import { describe, expect, it } from 'bun:test';
import { drizzle } from 'drizzle-orm/pg-proxy';

import { betterAuthSchema } from '@flowkit-demo/database';

import { createAuth } from './auth.config';

describe('BetterAuth Drizzle mapping', () => {
  it('resolves the member applicationRole model field through the real adapter', async () => {
    const statements: string[] = [];
    const database = drizzle(async (sql) => {
      statements.push(sql);
      return { rows: [] };
    }, { schema: betterAuthSchema });
    const testAuth = createAuth({ database });
    const context = await testAuth.$context;

    await expect(context.adapter.findOne({
      model: 'member',
      where: [{ field: 'applicationRole', value: 'employee' }],
    })).resolves.toBeNull();

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('"better_auth"."member"."application_role" = $1');
  });
});
