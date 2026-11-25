/**
 * Speed and ETA: an exponential moving average of bytes per second, sampled
 * at most every `minIntervalMs`, with a time-aware smoothing factor so the
 * value does not depend on how often progress events arrive.
 */
export class SpeedMeter {
  speed = 0;
  private lastAt: number | null = null;
  private lastBytes = 0;

  constructor(
    private readonly alpha = 0.3,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = 250,
  ) {}

  /** Feed the cumulative byte count. */
  sample(totalBytes: number): number {
    const t = this.now();
    if (this.lastAt === null) {
      this.lastAt = t;
      this.lastBytes = totalBytes;
      return this.speed;
    }
    const dt = t - this.lastAt;
    if (dt < this.minIntervalMs) return this.speed;
    const instant = Math.max(0, totalBytes - this.lastBytes) / (dt / 1000);
    // Weight per second: a = 1 - (1 - alpha)^(dt in s).
    const a = 1 - (1 - this.alpha) ** (dt / 1000);
    this.speed = this.speed === 0 ? instant : this.speed + a * (instant - this.speed);
    this.lastAt = t;
    this.lastBytes = totalBytes;
    return this.speed;
  }

  /** Forget timing (after a pause or a reconnect) but keep the last speed as a hint. */
  reset(totalBytes = 0): void {
    this.lastAt = null;
    this.lastBytes = totalBytes;
  }
}

/** Seconds left, or null when there is no usable speed. */
export function etaSeconds(remainingBytes: number, speed: number): number | null {
  if (remainingBytes <= 0) return 0;
  if (!(speed > 1)) return null;
  return Math.ceil(remainingBytes / speed);
}
