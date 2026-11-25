import type { Context, MiddlewareHandler } from "hono";
import type { ZodType, ZodTypeDef } from "zod";
import { ApiError } from "./errors";

type Target = "json" | "query" | "param";

/**
 * Zod validation middleware. On success the parsed value is available through
 * `c.req.valid(target)`; on failure it throws `VALIDATION_FAILED` (400) with the
 * flattened Zod issues in `error.data.issues`.
 *
 * Usage: `app.post("/x", validate("json", Schema), (c) => c.req.valid("json"))`
 */
export function validate<T extends Target, Out, In = Out>(
  target: T,
  schema: ZodType<Out, ZodTypeDef, In>,
): MiddlewareHandler<
  any,
  string,
  { in: { [K in T]: In }; out: { [K in T]: Out } }
> {
  return async (c, next) => {
    const raw = await readTarget(c, target);
    const result = await schema.safeParseAsync(raw);
    if (!result.success) {
      throw new ApiError(400, "VALIDATION_FAILED", "Request validation failed", {
        target,
        issues: result.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
      });
    }
    c.req.addValidatedData(target, result.data as object);
    await next();
  };
}

async function readTarget(c: Context, target: Target): Promise<unknown> {
  switch (target) {
    case "json":
      try {
        return await c.req.json();
      } catch {
        throw new ApiError(400, "BAD_REQUEST", "Body must be valid JSON");
      }
    case "query":
      return c.req.query();
    case "param":
      return c.req.param();
  }
}
