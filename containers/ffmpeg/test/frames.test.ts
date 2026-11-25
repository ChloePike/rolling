import { describe, expect, it } from "vitest";
import { endFrameArgs, FramesError, frameArgs, isPng, MAX_FRAMES, parseSceneCuts, sceneArgs, validateFrames } from "../src/frames.ts";

describe("frames builders", () => {
  it("builds a fast-seek single PNG frame command", () => {
    expect(frameArgs("https://m/a.mp4", 2.5, 512)).toEqual(["-v", "error", "-ss", "2.500", "-i", "https://m/a.mp4", "-frames:v", "1", "-vf", "scale=512:-2", "-f", "image2", "-c:v", "png", "pipe:1"]);
    expect(frameArgs("https://m/a.mp4", 0, null)).not.toContain("-vf");
    expect(endFrameArgs("u", 1, null).slice(0, 4)).toEqual(["-v", "error", "-sseof", "-1.000"]);
  });

  it("builds a scene-detection command with a clamped threshold", () => {
    const args = sceneArgs("https://m/a.mp4", 0.3);
    expect(args).toContain("scale=320:-2,select='gt(scene,0.3)',showinfo");
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
    expect(sceneArgs("u", 5)).toContain("scale=320:-2,select='gt(scene,0.95)',showinfo");
  });

  it("parses showinfo cut times, sorted and de-duplicated", () => {
    const log = [
      "[Parsed_showinfo_2 @ 0x1] config in time_base: 1/30",
      "[Parsed_showinfo_2 @ 0x1] n:   0 pts:  45 pts_time:1.5     duration:1 pos: 1 fmt:yuv420p",
      "[Parsed_showinfo_2 @ 0x1] n:   1 pts:  46 pts_time:1.533   duration:1",
      "[Parsed_showinfo_2 @ 0x1] n:   2 pts: 120 pts_time:4       duration:1",
      "frame=  3 fps=0.0",
    ].join("\n");
    expect(parseSceneCuts(log)).toEqual([1.5, 4]);
    expect(parseSceneCuts(log, 1)).toEqual([1.5]);
    expect(parseSceneCuts("nothing")).toEqual([]);
  });

  it("validates /frames bodies", () => {
    expect(validateFrames({ url: "https://m/a.mp4", times: [0, 1.5], puts: ["https://r2/a.png", "https://r2/b.png"], width: 640 })).toEqual({
      url: "https://m/a.mp4",
      times: [0, 1.5],
      puts: ["https://r2/a.png", "https://r2/b.png"],
      width: 640,
    });
    expect(validateFrames({ url: "https://m/a.mp4", times: [2] })).toMatchObject({ puts: null, width: null });
    const bad = [
      { url: "file:///etc/passwd", times: [0] },
      { url: "https://m/a.mp4", times: [] },
      { url: "https://m/a.mp4", times: Array.from({ length: MAX_FRAMES + 1 }, () => 0) },
      { url: "https://m/a.mp4", times: [-1] },
      { url: "https://m/a.mp4", times: [0, 1] },
      { url: "https://m/a.mp4", times: [0], puts: ["ftp://x"] },
      { url: "https://m/a.mp4", times: [0, 1], puts: ["https://r2/a.png"] },
      { url: "https://m/a.mp4", times: [0], width: 2 },
    ];
    for (const b of bad) expect(() => validateFrames(b)).toThrow(FramesError);
  });

  it("recognizes PNG bytes", () => {
    expect(isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
    expect(isPng(Buffer.from("not a png"))).toBe(false);
  });
});
