import { mergeMessages, type Messages } from '../merge';

/** One chunk per locale: every `messages/zh-TW/*.json` file, merged (loaded by `loadMessages`). */
const messages: Messages = mergeMessages(import.meta.glob<Messages>('@messages/zh-TW/*.json', { import: 'default', eager: true }));
export default messages;
