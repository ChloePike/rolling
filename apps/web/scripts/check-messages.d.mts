export const MESSAGES_DIR: string;
export function duplicateKeys(text: string): string[];
export function shape(message: string): { args: Map<string, string>; tags: Set<string> };
export function checkMessages(messagesDir?: string): {
  errors: string[];
  warnings: string[];
  report: Record<string, { translated: number; missing: string[]; extra: string[] }>;
  locales: string[];
};
