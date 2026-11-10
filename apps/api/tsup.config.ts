import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript sources, so they are bundled; third-party dependencies stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@traceforge\//],
});
