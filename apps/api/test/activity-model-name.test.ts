import { describe, expect, it } from "vitest";
import { modelName } from "../src/runs/activity";

describe("Activity model names", () => {
  it("uses the display name, else a readable name from the id (never the raw id)", () => {
    expect(modelName("bytedance/seedream-5.0-lite")).toBe("Seedream 5.0 Lite");
    expect(modelName("x-ai/grok-imagine-video-1.5-lite")).toBe("Grok Imagine Video 1.5 Lite");
    expect(modelName("plain")).toBe("Plain");
  });
});
