import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'sqlite', schema: './src/org/db/schema.ts', out: './src/org/db/sql' });
