import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'postgresql', schema: './src/schema.ts', out: './migrations', dbCredentials: { url: process.env.DATABASE_URL ?? 'postgresql://flowkitform:flowkitform@localhost:5441/flowkitform' } });
