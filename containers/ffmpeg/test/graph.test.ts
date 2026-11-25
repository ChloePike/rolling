import { describe, expect, it } from "vitest";
import { assText, assTime, atempoChain, buildAss, buildRender, keyframeDbExpr, n, type Edl, type InputInfo, type RenderJob } from "../src/graph.ts";
import { parseProgress, validateJob } from "../src/render.ts";

const OPTS = { assPath: "/tmp/r/captions.ass", filterPath: "/tmp/r/graph.txt", outPath: "/tmp/r/out.mp4" };
const AV: InputInfo = { url: "https://media.test/a.mp4", hasVideo: true, hasAudio: true };
const V: InputInfo = { url: "https://media.test/v.mp4", hasVideo: true, hasAudio: false };
const A: InputInfo = { url: "https://media.test/a.m4a", hasVideo: false, hasAudio: true };

function job(edl: Partial<Edl> & Pick<Edl, "tracks">, duration: number, extra: Partial<RenderJob> = {}): RenderJob {
  return { id: "exp_1", edl: { fps: 24, width: 1080, height: 1920, ...edl }, width: 720, height: 1280, fps: 24, duration, inputs: {}, ...extra };
}

function build(j: RenderJob, inputs: Record<string, InputInfo>) {
  return buildRender(j, { inputs, ...OPTS });
}

const lines = (f: string) => f.split(";\n");

/** Every link label is produced once and consumed once; `vout` and `aout` are produced once and left for `-map`. */
function expectWellFormed(filter: string) {
  const counts = new Map<string, number>();
  for (const m of filter.matchAll(/\[([a-z]+\d*)\]/g)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  for (const [l, c] of counts) expect(c, l).toBe(l === "vout" || l === "aout" ? 1 : 2);
  expect(counts.has("vout") && counts.has("aout")).toBe(true);
}

describe("filter graph builder", () => {
  it("trims each clip at the input, scales and pads to the output size, and concatenates back to back", () => {
    const r = build(
      job({ tracks: [{ id: "V1", kind: "video", clips: [{ id: "v1", assetId: "a", in: 1, out: 3, start: 0 }, { id: "v2", assetId: "b", in: 0, out: 2, start: 2 }] }] }, 4),
      { a: V, b: V },
    );
    expect(r.inputCount).toBe(2);
    expect(r.args.join(" ")).toContain("-ss 1 -t 2 -i https://media.test/v.mp4");
    expect(r.args.join(" ")).toContain("-ss 0 -t 2 -i https://media.test/v.mp4");
    expect(r.filter).toContain("[0:v]trim=duration=2,setpts=PTS-STARTPTS,fps=24");
    expect(r.filter).toContain("scale=720:1280:force_original_aspect_ratio=decrease");
    expect(r.filter).toContain("pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black");
    expect(r.filter).toMatch(/concat=n=2:v=1:a=0/);
    expect(r.filter).not.toContain("xfade");
    expect(r.filter).toContain("trim=duration=4,setpts=PTS-STARTPTS");
    // No sound anywhere: a silent track of the full length.
    expect(r.filter).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=4[aout]");
    const a = r.args;
    expect(a.slice(a.indexOf("-c:v"), a.indexOf("-c:v") + 2)).toEqual(["-c:v", "libx264"]);
    expect(a).toEqual(expect.arrayContaining(["-c:a", "aac", "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-filter_complex_script", OPTS.filterPath]));
    expect(a[a.length - 1]).toBe(OPTS.outPath);
    expect(a.slice(a.indexOf("-t", a.indexOf("-map")), a.indexOf("-t", a.indexOf("-map")) + 2)).toEqual(["-t", "4"]);
  });

  it("fills gaps, a missing asset and the tail with black", () => {
    const r = build(
      job({ tracks: [{ id: "V1", kind: "video", clips: [{ id: "v1", assetId: "a", in: 0, out: 1, start: 0.5 }, { id: "v2", assetId: null, in: 0, out: 1, start: 2 }] }] }, 4),
      { a: V },
    );
    const blanks = lines(r.filter).filter((l) => l.startsWith("color=c=black:s=720x1280"));
    expect(blanks.map((l) => /d=([\d.]+)/.exec(l)![1])).toEqual(["0.5", "0.5", "1", "1"]);
  });

  it("retimes for speed (setpts + atempo chain) and plays reversed clips backwards", () => {
    const r = build(job({ tracks: [{ id: "V1", kind: "video", clips: [{ id: "v1", assetId: "a", in: 0, out: 4, start: 0, speed: 4, reverse: true }] }] }, 1), { a: AV });
    expect(r.filter).toContain("setpts=PTS-STARTPTS,reverse,setpts=PTS/4,fps=24");
    expect(r.filter).toContain("trim=duration=1,");
    expect(r.filter).toContain("[0:a]atrim=duration=4,asetpts=PTS-STARTPTS,areverse,atempo=2,atempo=2,");
    expect(atempoChain(0.25)).toEqual(["atempo=0.5", "atempo=0.5"]);
    expect(atempoChain(1.5)).toEqual(["atempo=1.5"]);
    expect(atempoChain(3)).toEqual(["atempo=2", "atempo=1.5"]);
    expect(atempoChain(1)).toEqual([]);
  });

  it("applies transforms through an overlay on a canvas: scale, rotation, position, opacity", () => {
    const r = build(
      job({ tracks: [{ id: "V1", kind: "video", clips: [{ id: "v1", assetId: "a", in: 0, out: 2, start: 0, transform: { scale: 1.5, x: 40, y: -20, rotation: 90, opacity: 0.5 } }] }] }, 2),
      { a: V },
    );
    expect(r.filter).toContain("scale=trunc(iw*1.5/2)*2:trunc(ih*1.5/2)*2,format=rgba,colorchannelmixer=aa=0.5,rotate=90*PI/180:c=none:ow=rotw(90*PI/180):oh=roth(90*PI/180)");
    expect(r.filter).toMatch(/color=c=black:s=720x1280:r=24:d=2,format=rgba\[canvas\d+\]/);
    expect(r.filter).toContain("overlay=x=(main_w-overlay_w)/2+(40):y=(main_h-overlay_h)/2+(-20):eof_action=pass");
    expect(r.filter).not.toContain("pad=720:1280");
  });

  it("fades in from black (video) and from silence (audio)", () => {
    const r = build(job({ tracks: [{ id: "V1", kind: "video", clips: [{ id: "v1", assetId: "a", in: 0, out: 2, start: 0, fadeIn: 0.5 }] }] }, 2), { a: AV });
    expect(r.filter).toContain("fade=t=in:st=0:d=0.5");
    expect(r.filter).toContain("afade=t=in:st=0:d=0.5");
  });

  it("crossfades with xfade on the cut, with frozen handles so the timing stays", () => {
    const r = build(
      job({
        tracks: [
          {
            id: "V1",
            kind: "video",
            clips: [
              { id: "v1", assetId: "a", in: 0, out: 3, start: 0, transitionOut: { type: "dissolve", dur: 1 } },
              { id: "v2", assetId: "b", in: 0, out: 2, start: 3 },
            ],
          },
        ],
      }, 5),
      { a: V, b: V },
    );
    expect(r.filter).toContain("tpad=stop_mode=clone:stop_duration=0.5,format=yuv420p");
    expect(r.filter).toContain("tpad=start_mode=clone:start_duration=0.5,format=yuv420p");
    // v1 lasts 3 + 0.5 in the chain; the fade starts 1 s before that end, i.e. 0.5 s before the cut.
    expect(r.filter).toContain("xfade=transition=fade:duration=1:offset=2.5");
    expectWellFormed(r.filter);
    // A transition before a gap is ignored.
    const gap = build(
      job({ tracks: [{ id: "V1", kind: "video", clips: [{ id: "v1", assetId: "a", in: 0, out: 2, start: 0, transitionOut: { type: "dissolve", dur: 1 } }, { id: "v2", assetId: "b", in: 0, out: 2, start: 3 }] }] }, 5),
      { a: V, b: V },
    );
    expect(gap.filter).not.toContain("xfade");
  });

  it("burns in captions from an ASS file with exact times", () => {
    const edl: Edl = {
      fps: 24,
      width: 1080,
      height: 1920,
      tracks: [
        { id: "C1", kind: "caption", clips: [{ id: "c1", start: 0.4, end: 4, text: "Morning. {The} first\\sip\nof the mountains." }, { id: "c2", start: 61.257, end: 62, text: "Later" }] },
      ],
    };
    const r = build(job(edl, 62), {});
    expect(r.filter).toContain("ass=filename='/tmp/r/captions.ass',format=yuv420p[vout]");
    const ass = r.ass!;
    expect(ass).toContain("PlayResX: 720\nPlayResY: 1280");
    expect(ass).toContain("Dialogue: 0,0:00:00.40,0:00:04.00,Caption,,0,0,0,,Morning. ｛The｝ first＼sip\\Nof the mountains.");
    expect(ass).toContain("Dialogue: 0,0:01:01.26,0:01:02.00,Caption");
    expect(assTime(3725.5)).toBe("1:02:05.50");
    expect(assText("a{\\b1}b")).toBe("a｛＼b1｝b");
    expect(buildAss({ ...edl, tracks: [] }, 720, 1280, 5)).toBeNull();
    // Captions past the export end are cut.
    expect(buildAss(edl, 720, 1280, 2)).toContain("0:00:00.40,0:00:02.00");
    expect(buildAss(edl, 720, 1280, 2)).not.toContain("Later");
  });

  it("mixes voice, music and video sound with gain, delays, keyframed gain and sidechain ducking", () => {
    const edl: Edl = {
      fps: 24,
      width: 1080,
      height: 1920,
      tracks: [
        { id: "V1", kind: "video", clips: [{ id: "v1", assetId: "av", in: 0, out: 4, start: 0, gainDb: -3 }] },
        { id: "A1", kind: "voice", clips: [{ id: "a1", assetId: "vo", in: 0, out: 3, start: 0.4 }, { id: "a2", assetId: "vo", in: 3, out: 4, start: 3.5 }] },
        { id: "A2", kind: "music", clips: [{ id: "m1", assetId: "mu", in: 0, out: 6, start: 0, gainDb: -6, duckUnder: ["A1"], gainKeyframes: [{ t: 0, db: -24 }, { t: 0.4, db: -6 }, { t: 5, db: -30 }] }] },
      ],
    };
    const r = build(job(edl, 5), { av: AV, vo: A, mu: A });
    expect(r.inputCount).toBe(4);
    const f = r.filter;
    expect(f).toContain("volume=-3dB");
    expect(f).toContain("adelay=delays=400:all=1");
    expect(f).toContain("adelay=delays=3500:all=1");
    expect(f).toMatch(/\[ac\d+\]\[ac\d+\]amix=inputs=2:duration=longest:normalize=0\[bus\d+\]/);
    expect(f).toContain(`volume='pow(10,(${keyframeDbExpr([{ t: 0, db: -24 }, { t: 0.4, db: -6 }, { t: 5, db: -30 }])})/20)':eval=frame`);
    // The voice bus feeds the mix and the compressor on the music bus.
    expect(f).toMatch(/\[bus\d+\]asplit=2\[tap\d+\]\[tap\d+\]/);
    expect(f).toMatch(/sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350:makeup=1\[ducked\d+\]/);
    expect(f).toMatch(/amix=inputs=3:duration=longest:normalize=0\[mix\d+\]/);
    expect(f).toContain("apad=whole_dur=5,atrim=duration=5,asetpts=PTS-STARTPTS[aout]");
    expectWellFormed(f);
  });

  it("keyframed gain matches the editor's linear dB interpolation", () => {
    const expr = keyframeDbExpr([{ t: 1, db: -20 }, { t: 3, db: 0 }]);
    const evalAt = (t: number) => Function("t", "lte", "ifn", `return ${expr.replace(/if\(/g, "ifn(")}`)(t, (a: number, b: number) => (a <= b ? 1 : 0), (c: number, a: number, b: number) => (c ? a : b));
    expect(evalAt(0)).toBe(-20);
    expect(evalAt(2)).toBeCloseTo(-10);
    expect(evalAt(3)).toBeCloseTo(0);
    expect(evalAt(9)).toBe(0);
    expect(keyframeDbExpr([{ t: 0, db: -6 }])).toBe("-6");
  });

  it("layers further video tracks as transparent overlays", () => {
    const r = build(
      job({ tracks: [
        { id: "V1", kind: "video", clips: [{ id: "v1", assetId: "a", in: 0, out: 2, start: 0 }] },
        { id: "V2", kind: "video", clips: [{ id: "v2", assetId: "b", in: 0, out: 1, start: 0.5, transform: { scale: 0.5, x: 0, y: 0, rotation: 0, opacity: 1 } }] },
      ] }, 2),
      { a: V, b: V },
    );
    expect(r.filter).toContain("color=c=black@0:s=720x1280");
    expect(r.filter).toMatch(/overlay=0:0:eof_action=pass:format=auto,format=yuv420p\[comp\d+\]/);
    expectWellFormed(r.filter);
  });

  it("formats numbers without exponents and validates jobs", () => {
    expect(n(1e-7)).toBe("0");
    expect(n(0.1 + 0.2)).toBe("0.3");
    expect(() => n(Number.NaN)).toThrow();
    const ok = job({ tracks: [] }, 3, { inputs: { a: { url: "https://x.test/a" } } });
    expect(validateJob(ok)).toBe(ok);
    expect(() => validateJob({ ...ok, width: 721 })).toThrow(/even/);
    expect(() => validateJob({ ...ok, duration: 4000 })).toThrow(/duration/);
    expect(() => validateJob({ ...ok, inputs: { a: { url: "file:///etc/passwd" } } })).toThrow(/http/);
    expect(() => validateJob({ ...ok, edl: { ...ok.edl, tracks: [{ id: "V", kind: "video", clips: [{ id: "v", in: 2, out: 1, start: 0 }] }] } })).toThrow(/media clip/);
    expect(parseProgress("frame=10\nout_time_us=1500000\nprogress=continue\n", 3)).toBe(0.5);
    expect(parseProgress("frame=10\n", 3)).toBeNull();
    expect(parseProgress("out_time_us=9000000\n", 3)).toBe(0.99);
  });
});
