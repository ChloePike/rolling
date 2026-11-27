/**
 * Collaboration notifications (D-031). In-app through the recipient's UserHub
 * (`notification` on the user channel) and, for mentions and review
 * decisions, by email. Each category follows the recipient's Settings →
 * Notifications switch (`prefs.notifications.comments | mentions | reviews`).
 *
 * Emails are rendered from `@rolling/core/collab` (`renderCollabEmail`) and
 * sent with the configured provider in the background (`waitUntil`), one
 * retry on a retryable failure.
 */
import { DEFAULT_NOTIFICATIONS, type NotificationPrefs } from "@rolling/core/auth/prefs";
import { renderCollabEmail, type CollabEmailData, type CollabEmailId } from "@rolling/core/collab";
import { EmailSendError } from "@rolling/core/email/EmailProvider";
import { emailProvider } from "../auth/email";

export type NotifyCategory = "comments" | "mentions" | "reviews";

export interface CollabNotification {
  kind: "comment" | "mention" | "review.comment" | "review.decision";
  projectId: string;
  title: string;
  message: string;
  href: string;
  threadId?: string;
  reviewId?: string;
}

type Waiter = { waitUntil(p: Promise<unknown>): void } | undefined;

interface UserHubBroadcast {
  broadcast(type: "notification", payload: unknown): Promise<number>;
}

/** Notification switches of several users (defaults for users without a row). */
export async function notificationPrefs(env: Env, userIds: string[]): Promise<Map<string, NotificationPrefs>> {
  const out = new Map<string, NotificationPrefs>();
  for (const id of userIds) out.set(id, DEFAULT_NOTIFICATIONS);
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    if (!chunk.length) continue;
    const rows = await env.DB.prepare(`SELECT user_id, notifications FROM user_prefs WHERE user_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ user_id: string; notifications: string | null }>();
    for (const r of rows.results) {
      try {
        out.set(r.user_id, { ...DEFAULT_NOTIFICATIONS, ...(JSON.parse(r.notifications ?? "{}") as Partial<NotificationPrefs>) });
      } catch {
        // Keep defaults.
      }
    }
  }
  return out;
}

export function appUrl(env: Env, path: string): string {
  return `${(env.PUBLIC_APP_URL || "https://rolling.actor").replace(/\/+$/, "")}${path}`;
}

/** Sends an in-app notification to each recipient whose switch for `category` is on; returns who got it. */
export async function notifyInApp(env: Env, recipients: string[], category: NotifyCategory, payload: CollabNotification, wait?: Waiter): Promise<string[]> {
  const unique = [...new Set(recipients)];
  if (!unique.length) return [];
  const prefs = await notificationPrefs(env, unique);
  const allowed = unique.filter((id) => prefs.get(id)?.[category] !== false);
  const work = Promise.all(
    allowed.map((id) => (env.USER_HUB.get(env.USER_HUB.idFromName(id)) as unknown as UserHubBroadcast).broadcast("notification", payload).catch(() => 0)),
  );
  if (wait) wait.waitUntil(work);
  else await work;
  return allowed;
}

/** Sends one collaboration email (to an address, or to a user's address), in the background when possible. */
export async function sendCollabEmail<T extends CollabEmailId>(env: Env, to: { email?: string; userId?: string }, id: T, data: CollabEmailData<T>, wait?: Waiter): Promise<void> {
  const work = (async () => {
    let address = to.email;
    if (!address && to.userId) address = (await env.DB.prepare("SELECT email FROM users WHERE id = ?1").bind(to.userId).first<{ email: string }>())?.email;
    if (!address) return;
    const rendered = renderCollabEmail(id, data, env.APP_NAME || "Rolling");
    const message = { to: address, ...rendered, template: id, data: data as Record<string, unknown>, idempotencyKey: `collab:${id}:${crypto.randomUUID()}` };
    const provider = emailProvider(env);
    try {
      await provider.send(message);
    } catch (err) {
      if (err instanceof EmailSendError && !err.retryable) throw err;
      await new Promise((r) => setTimeout(r, 1000));
      await provider.send(message);
    }
  })().catch((err: unknown) => console.error(JSON.stringify({ msg: "collab email failed", template: id, error: String(err).slice(0, 300) })));
  if (wait) wait.waitUntil(work);
  else await work;
}

/** Emails each recipient whose switch for `category` is on. */
export async function emailUsers<T extends CollabEmailId>(env: Env, recipients: string[], category: NotifyCategory, id: T, data: CollabEmailData<T>, wait?: Waiter): Promise<void> {
  const unique = [...new Set(recipients)];
  if (!unique.length) return;
  const prefs = await notificationPrefs(env, unique);
  await Promise.all(unique.filter((u) => prefs.get(u)?.[category] !== false).map((u) => sendCollabEmail(env, { userId: u }, id, data, wait)));
}
