import { mergeMessages, type Messages } from './merge';

/**
 * English outside Home's first paint, as one chunk (`loadEnglishRest` in ./messages.ts).
 * The excluded list mirrors the first-paint glob in ./messages.ts (englishRest.test.ts).
 */
const files = import.meta.glob<Messages>(
  ['@messages/en/*.json', '!@messages/en/{shell,home,prompt,overlays,picker,templates,transfers,pwa,auth,agent,trial,trust}.json', '!@messages/en/email.json'],
  { import: 'default', eager: true },
);

export default mergeMessages(files);
