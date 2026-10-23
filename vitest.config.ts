import { defineConfig } from 'vitest/config';

// Unit tests for the pure library in src/lib. Separate from vite.config.ts so
// tests never load .env or the dev API middleware.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
});
