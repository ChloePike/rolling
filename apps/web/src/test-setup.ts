import { loadMockData } from '@/lib/api/mode';

// Unit tests run in mock mode by default (vitest.config.ts): load the mock data like the app entry does.
await loadMockData();
