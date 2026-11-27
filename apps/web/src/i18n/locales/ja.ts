import { mergeMessages, type Messages } from '../merge';

/** One chunk per locale: every `messages/ja/*.json` file, merged (loaded by `loadMessages`). */
const messages: Messages = mergeMessages(import.meta.glob<Messages>('@messages/ja/*.json', { import: 'default', eager: true }));
export default messages;
