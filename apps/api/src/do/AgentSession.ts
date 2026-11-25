import { DurableObject } from "cloudflare:workers";
import { agentMigrations } from "@rolling/db/do/agent";
import { migrateDurableObject } from "@rolling/db/do/migrate";

/**
 * One instance per agent thread: messages, proposals, turn loop.
 * M0 stub: schema migration and `ping()` only; the harness lands in M6.
 */
export class AgentSession extends DurableObject<Env> {
  private schemaVersion = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.schemaVersion = migrateDurableObject(ctx.storage, agentMigrations);
    });
  }

  async ping(): Promise<{ ok: true; schemaVersion: number }> {
    return { ok: true, schemaVersion: this.schemaVersion };
  }
}
