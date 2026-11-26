import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@/': `${r('./src')}/`,
      '@messages': r('../../messages'),
      '@legal': r('../../legal'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Unit tests run the mock clients unless a test opts into the real path (lib/api/mode.ts).
    env: { VITE_API_MODE: 'mock' },
    setupFiles: ['./src/test-setup.ts'],
  },
});
