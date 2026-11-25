import { DurableObject } from "cloudflare:workers";
import { creditsMigrations } from "@rolling/db/do/credits";
import { migrateDurableObject } from "@rolling/db/do/migrate";

/**
 * One instance per workspace; the only place balances change (quote -> hold ->
 * settle or release). M0 stub: schema migration and `ping()` only; ledger in M2.
 */
export class CreditAccount extends DurableObject<Env> {
  private schemaVersion = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.schemaVersion = migrateDurableObject(ctx.storage, creditsMigrations);
    });
  }

  async ping(): Promise<{ ok: true; schemaVersion: number }> {
    return { ok: true, schemaVersion: this.schemaVersion };
  }
}
