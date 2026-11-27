import { loadEnglishRest } from '@/i18n/messages';
import { loadMockData } from '@/lib/api/mode';

// Unit tests run in mock mode by default (vitest.config.ts): load the mock data like the app entry does.
await loadMockData();
// Every English message, like the app has after its first render (i18n/messages.ts).
await loadEnglishRest();
