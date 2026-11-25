/** Shell data access. Mock until the endpoints land. */

/** `POST /api/feedback` (mock: resolves after a short delay). */
export async function sendFeedback(_text: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
}
