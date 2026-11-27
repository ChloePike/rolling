import { mergeMessages, type Messages } from '../merge';

/** One chunk per locale: every `messages/ko/*.json` file, merged (loaded by `loadMessages`). */
const messages: Messages = mergeMessages(import.meta.glob<Messages>('@messages/ko/*.json', { import: 'default', eager: true }));
export default messages;
