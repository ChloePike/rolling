import { describe, expect, it } from "vitest";
import {
  AGENT_USAGE_RETENTION_DAYS,
  isTombstone,
  retentionCutoffs,
  SAFETY_EXCERPT_RETENTION_DAYS,
  SAFETY_LOG_RETENTION_DAYS,
  tombstoneUserId,
} from "./privacy";
import { crc32, readZip, zipStore } from "./zip";

describe("privacy config", () => {
  it("uses the retention periods the privacy policy states", () => {
    expect(SAFETY_LOG_RETENTION_DAYS).toBe(365);
    expect(SAFETY_EXCERPT_RETENTION_DAYS).toBe(90);
    expect(AGENT_USAGE_RETENTION_DAYS).toBe(400);
    const now = Date.UTC(2026, 10, 26);
    const c = retentionCutoffs(now);
    expect(now - c.safetyEvents).toBe(365 * 86_400_000);
    expect(now - c.safetyExcerpts).toBe(90 * 86_400_000);
    expect(now - c.agentUsage).toBe(400 * 86_400_000);
  });

  it("tombstones are stable, distinct per user and not user ids", async () => {
    const a = await tombstoneUserId("usr_01J00000000000000000000000");
    expect(a).toBe(await tombstoneUserId("usr_01J00000000000000000000000"));
    expect(a).not.toBe(await tombstoneUserId("usr_01J00000000000000000000001"));
    expect(a).toMatch(/^usr_deleted_[0-9a-f]{32}$/);
    expect(a).not.toContain("01J0000");
    expect(isTombstone(a)).toBe(true);
    expect(isTombstone("usr_01J00000000000000000000000")).toBe(false);
  });
});

describe("zip", () => {
  it("round-trips stored entries with UTF-8 names", () => {
    const enc = new TextEncoder();
    const files = [
      { name: "profile.json", data: enc.encode('{"a":1}') },
      { name: "projects/prj_1 é.json", data: enc.encode("x".repeat(1000)) },
      { name: "empty.txt", data: new Uint8Array() },
    ];
    const zip = zipStore(files, new Date(Date.UTC(2026, 0, 2, 3, 4, 6)));
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const back = readZip(zip);
    expect(back.map((f) => f.name)).toEqual(files.map((f) => f.name));
    expect(new TextDecoder().decode(back[1]!.data)).toBe("x".repeat(1000));
  });

  it("crc32 matches the reference value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
