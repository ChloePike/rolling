import type { GenerationProvider, JobStatus } from './types';

export interface PollOptions {
  /** First wait between polls. */
  intervalMs?: number;
  /** Upper bound for the backoff. */
  maxIntervalMs?: number;
  /** Give up after this long. */
  timeoutMs?: number;
  /** Called with every status read. */
  onStatus?: (status: JobStatus) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class PollTimeoutError extends Error {
  override readonly name = 'PollTimeoutError';
  constructor(
    readonly externalId: string,
    readonly last: JobStatus | null,
  ) {
    super(`Job ${externalId} did not finish in time.`);
  }
}

/**
 * Polls `provider.status` with capped exponential backoff until the job
 * succeeds or fails. For scripts and tests; Workflows use `step.sleep` instead.
 */
export async function pollUntilDone(
  provider: Pick<GenerationProvider, 'status'>,
  externalId: string,
  opts: PollOptions = {},
): Promise<JobStatus> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + (opts.timeoutMs ?? 15 * 60 * 1000);
  let interval = opts.intervalMs ?? 2000;
  let last: JobStatus | null = null;
  for (;;) {
    last = await provider.status(externalId);
    opts.onStatus?.(last);
    if (last.state === 'succeeded' || last.state === 'failed') return last;
    if (now() + interval > deadline) throw new PollTimeoutError(externalId, last);
    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), opts.maxIntervalMs ?? 15_000);
  }
}
