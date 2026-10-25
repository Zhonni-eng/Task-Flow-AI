import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Tests reuse the app's Vite config (React plugin). Component tests run in jsdom;
// storage tests opt into Node with a `// @vitest-environment node` comment.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.{js,jsx}'],
      setupFiles: ['./tests/setup/setup.js'],
      restoreMocks: true,
      // Component tests render the whole app; give slow CI machines some headroom.
      testTimeout: 15000,
      // Many parallel jsdom workers starve each other: measured on a 16-core machine, the slowest
      // component test took 1.6 s alone but up to 15 s with all workers (a timeout). With 4 workers
      // the slowest takes about 4 s and the whole run is only slightly longer.
      maxWorkers: 4,
    },
  }),
);
