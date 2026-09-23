import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Integration suites drive registration through the development-only
    // verification-token endpoint and read the global audit listing.
    env: { N2F_DEV_ENDPOINTS: 'true' },
  },
});
