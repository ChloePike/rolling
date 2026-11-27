import { describe, expect, it } from "vitest";
import { guessSurface, promptTitle, runSurface, specRunTitle } from "../src/runs/surface";

describe("run surface (0025)", () => {
  it("keeps the surface consistent with what was quoted", () => {
    expect(runSurface({ promptSpec: { kind: "video" } }, "home")).toBe("home");
    expect(runSurface({ promptSpec: { kind: "video" } })).toBe("quick");
    expect(runSurface({ promptSpec: { kind: "image" } }, "canvas")).toBe("quick");
    expect(runSurface({ promptSpec: { kind: "remix" } }, "home")).toBe("remix");
    expect(runSurface({ scope: "all" })).toBe("canvas");
    expect(runSurface({ scope: "node" }, "agent")).toBe("agent");
    expect(runSurface({ scope: "node" }, "home")).toBe("canvas");
  });

  it("guesses older runs from tool and source", () => {
    expect(guessSurface({ surface: "home", tool: "quick", source: "quickCreate" })).toBe("home");
    expect(guessSurface({ surface: null, tool: "avatar", source: "quickCreate" })).toBe("avatar");
    expect(guessSurface({ surface: null, tool: null, source: "quickCreate" })).toBe("quick");
    expect(guessSurface({ tool: null, source: "canvas" })).toBe("canvas");
  });

  it("names a spec run by its prompt", () => {
    expect(promptTitle("  A slow   push-in on @[Lamp]\nsecond line")).toBe("A slow push-in on Lamp");
    const long = promptTitle("A woman in her thirties in running gear pauses mid-workout on a rooftop and drinks from the bottle");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toMatch(/\s…$/);
    expect(promptTitle(" \n ")).toBe("");
    expect(specRunTitle({ kind: "video", prompt: "" }, "Video")).toBe("Video");
    expect(specRunTitle({ kind: "video", prompt: "x", title: "Shot A" }, "Video")).toBe("Shot A");
    expect(specRunTitle({ kind: "avatar", prompt: "Hello there" }, "Avatar")).toBe("Avatar");
  });
});
