import { describe, expect, it } from "vitest";
import { assColor, assStyle, buildAss, buildRender, pwlExpr, reframeCrop, watermarkXY, type CaptionLook, type Edl, type InputInfo, type RenderJob } from "../src/graph.ts";
import { audioCutArgs, lastFrameArgs, parseSilences, resizeArgs, resizeFilter, silenceArgs } from "../src/post.ts";
import { ANALYSIS, focusSamples, frameFocus, reduceKeys, smoothPath, toClipTime } from "../src/reframe.ts";
import { validateResizeJob } from "../src/jobs.ts";
import { validateJob } from "../src/render.ts";

const OPTS = { assPath: "/tmp/r/captions.ass", filterPath: "/tmp/r/graph.txt", outPath: "/tmp/r/out.mp4" };
const AV: InputInfo = { url: "https://media.test/a.mp4", hasVideo: true, hasAudio: true };
const VO: InputInfo = { url: "https://media.test/vo.m4a", hasVideo: false, hasAudio: true };

const LOOK: CaptionLook = {
  id: "clean", weight: 500, size: 0.05, outline: 0, box: { opacity: 0.62 }, shadow: false, marginV: 0.08, maxLines: 2,
  text: "#111111", outlineColor: "#000000", boxColor: "#FFCB2B", fontFamily: "Noto Sans", cjkFamily: "Noto Sans CJK JP",
};

function edl(extra: Partial<Edl> = {}): Edl {
  return {
    fps: 24,
    width: 1920,
    height: 1080,
    tracks: [
      { id: "C1", kind: "caption", clips: [{ id: "c1", start: 0.5, end: 2, text: "字幕のテスト" }], lang: "ja" },
      { id: "V1", kind: "video", clips: [{ id: "v1", assetId: "a", in: 0, out: 3, start: 0 }, { id: "v2", assetId: "a", in: 0, out: 1, start: 3, reframe: { mode: "manual", x: 0.2, y: 0.5 } }] },
      { id: "A1", kind: "voice", clips: [{ id: "a1", assetId: "vo", in: 0, out: 3, start: 0 }] },
    ],
    ...extra,
  };
}

function job(extra: Partial<RenderJob> = {}): RenderJob {
  return { id: "exp_1", edl: edl(), width: 1080, height: 1920, fps: 24, duration: 4, inputs: { a: { url: AV.url }, vo: { url: VO.url } }, ...extra };
}

const build = (j: RenderJob, more: Record<string, unknown> = {}) => buildRender(j, { inputs: { a: AV, vo: VO }, ...OPTS, ...more });

describe("caption burn-in looks", () => {
  it("writes ASS colours as &HAABBGGRR", () => {
    expect(assColor("#FFCB2B")).toBe("&H002BCBFF");
    expect(assColor("#000000", 0.5)).toBe("&H80000000");
  });

  it("draws a clean box in the brand color and picks the regional CJK family", () => {
    const style = assStyle(LOOK, 1080, 1920, "ja");
    expect(style).toMatch(/^Style: Caption,Noto Sans CJK JP,54,&H00111111,/);
    // BorderStyle 3 (box) in the box colour with its opacity.
    expect(style).toContain(",&H612BCBFF,");
    expect(style.split(",")[15]).toBe("3");
    expect(assStyle({ ...LOOK, fontFamily: "Brand Sans" }, 1080, 1920, "ja")).toContain("Caption,Brand Sans,");
    const bold = assStyle({ ...LOOK, id: "bold_social", weight: 800, size: 0.072, outline: 0.12, box: null, shadow: true, marginV: 0.22 }, 1080, 1920, "en");
    const f = bold.split(",");
    expect(f[1]).toBe("Noto Sans");
    expect(f[7]).toBe("-1");
    expect(f[15]).toBe("1");
    expect(Number(f[16])).toBeGreaterThan(5);
    expect(f[21]).toBe(String(Math.round(1920 * 0.22)));
  });

  it("burns captions through libass with the job's font folder, or not at all when off", () => {
    const r = build(job({ captions: { look: LOOK, lang: "ja" } }), { fontsDir: "/tmp/r/fonts" });
    expect(r.ass).toContain("Dialogue: 0,0:00:00.50,0:00:02.00,Caption,,0,0,0,,字幕のテスト");
    expect(r.filter).toContain("ass=filename='/tmp/r/captions.ass':fontsdir='/tmp/r/fonts',");
    const off = build(job({ captions: null }));
    expect(off.ass).toBeNull();
    expect(off.filter).not.toContain("ass=");
    expect(buildAss(edl(), 1080, 1920, 4)).toContain("Style: Caption,Noto Sans CJK SC");
  });
});

describe("smoother motion", () => {
  it("interpolates after compositing and before captions, and outputs the new rate", () => {
    const r = build(job({ interpolateFps: 60, captions: { look: LOOK, lang: "en" } }));
    const mi = r.filter.indexOf("minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff");
    expect(mi).toBeGreaterThan(0);
    expect(r.filter.indexOf("ass=filename")).toBeGreaterThan(mi);
    expect(r.args.slice(r.args.indexOf("-r"), r.args.indexOf("-r") + 2)).toEqual(["-r", "60"]);
    expect(build(job()).args.slice(build(job()).args.indexOf("-r"), build(job()).args.indexOf("-r") + 2)).toEqual(["-r", "24"]);
  });
});

describe("reframe crop", () => {
  it("covers the frame and crops along the focus path; center and manual override auto", () => {
    expect(pwlExpr([{ t: 0, v: 0.3 }, { t: 2, v: 0.7 }])).toBe("if(lte(t,0),0.3,if(lte(t,2),0.3+(0.4)*(t-(0))/2,0.7))");
    expect(reframeCrop(1080, 1920, [{ t: 0, x: 0.25, y: 0.5 }])).toBe("crop=w=1080:h=1920:x='max(0,min(iw-ow,iw*(0.25)-ow/2))':y='max(0,min(ih-oh,ih*(0.5)-oh/2))'");
    const r = build(job({ reframe: true }), { focus: { v1: [{ t: 0, x: 0.3, y: 0.5 }, { t: 2, x: 0.6, y: 0.5 }] } });
    expect(r.filter).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(r.filter).toContain("iw*(if(lte(t,0),0.3,if(lte(t,2),0.3+(0.3)*(t-(0))/2,0.6)))-ow/2");
    expect(r.filter).toContain("iw*(0.2)-ow/2");
    expect(r.filter).not.toContain("pad=1080:1920");
    expect(build(job()).filter).toContain("pad=1080:1920");
  });

  it("finds a bright moving subject and smooths the path without jitter", () => {
    const W = ANALYSIS.width;
    const H = ANALYSIS.height;
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) {
      const f = new Uint8Array(W * H).fill(30);
      const cx = 12 + i;
      for (let y = 26; y < 38; y++) for (let x = cx; x < cx + 8; x++) f[y * W + x] = 230;
      frames.push(f);
    }
    const one = frameFocus(frames[4]!, frames[3]!);
    expect(one.x).toBeGreaterThan(0.2);
    expect(one.x).toBeLessThan(0.4);
    expect(Math.abs(one.y - 0.5)).toBeLessThan(0.1);
    const path = smoothPath(focusSamples(frames));
    expect(path[0]!.x).toBeLessThan(0.45);
    for (let i = 1; i < path.length; i++) expect(Math.abs(path[i]!.x - path[i - 1]!.x) / (path[i]!.t - path[i - 1]!.t || 1)).toBeLessThanOrEqual(0.25 + 1e-6);
    // A flat picture stays centered; tiny wobble inside the dead zone is held still.
    expect(frameFocus(new Uint8Array(W * H).fill(90), null)).toEqual({ x: 0.5, y: 0.5, w: 0 });
    const wobble = smoothPath([0.5, 0.52, 0.49, 0.51].map((x, i) => ({ t: i, x, y: 0.5, w: 1 })));
    expect(new Set(wobble.map((k) => k.x)).size).toBe(1);
    expect(reduceKeys(Array.from({ length: 40 }, (_, i) => ({ t: i, x: (i % 2) * 0.5, y: 0.5 })), 8)).toHaveLength(8);
    expect(toClipTime([{ t: 1, x: 0.2, y: 0.5 }], { in: 2, out: 6, speed: 2 })).toEqual([{ t: 0.5, x: 0.2, y: 0.5 }]);
    expect(toClipTime([{ t: 1, x: 0.2, y: 0.5 }], { in: 2, out: 6, reverse: true })).toEqual([{ t: 3, x: 0.2, y: 0.5 }]);
  });
});

describe("loudness", () => {
  it("normalises the mix for social presets and every voice-lane clip before mixing", () => {
    const enc = { crf: null, videoKbps: 8000, maxKbps: 10000, bufferKbps: 16000, profile: "high" as const, level: "4.2" as const, audioKbps: 192, loudnessLufs: -14, truePeakDb: -1 };
    const r = build(job({ encode: enc, voiceLufs: -16 }));
    expect(r.filter).toContain("loudnorm=I=-14:TP=-1:LRA=11,aresample=48000");
    expect(r.filter).toMatch(/\[\d+:a\]atrim[^\n]*loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000/);
    expect(r.args).toEqual(expect.arrayContaining(["-b:v", "8000k", "-maxrate", "10000k", "-bufsize", "16000k", "-profile:v", "high", "-level:v", "4.2"]));
    expect(r.args).not.toContain("-crf");
    const plain = build(job());
    expect(plain.filter).not.toContain("loudnorm");
    expect(plain.args).toContain("-crf");
  });
});

describe("brand kit on export", () => {
  it("overlays the watermark at its corner and adds intro and end cards around the cut", () => {
    const r = build(
      job({ brand: { watermark: { url: "https://media.test/logo.png", position: "top_left", opacity: 0.8, size: 0.12 }, intro: { seconds: 2, background: "#3B82F6", color: "#FFFFFF", text: "Hello" }, outro: { seconds: 1.5, background: "#000000", color: "#FFFFFF", text: "", logoUrl: "https://media.test/logo.png" } } }),
      { cards: { intro: { textPath: "/tmp/r/intro.txt", fontFile: "/fonts/a.ttf" }, outro: { textPath: "/tmp/r/outro.txt", fontFile: "/fonts/a.ttf" } } },
    );
    expect(r.args.join(" ")).toContain("-loop 1 -t 4 -i https://media.test/logo.png");
    expect(r.filter).toContain("colorchannelmixer=aa=0.8");
    expect(r.filter).toContain("overlay=x=43:y=43");
    expect(r.filter).toContain("color=c=0x3B82F6:s=1080x1920:r=24:d=2,format=yuv420p,drawtext=fontfile='/fonts/a.ttf':textfile='/tmp/r/intro.txt'");
    expect(r.filter).toMatch(/concat=n=3:v=1:a=0,format=yuv420p\[vout\]/);
    expect(r.totalDuration).toBe(7.5);
    expect(r.filter).toContain("adelay=delays=2000:all=1,apad=whole_dur=7.5,atrim=duration=7.5");
    expect(r.args.slice(-3)).toEqual(["-t", "7.5", OPTS.outPath]);
    expect(watermarkXY("bottom_right", 1920, 1080)).toEqual({ x: "main_w-overlay_w-43", y: "main_h-overlay_h-43" });
  });

  it("validates brand pieces in the job", () => {
    const base = { ...job(), inputs: { a: { url: AV.url } } };
    expect(() => validateJob({ ...base, brand: { intro: { seconds: 2, background: "red", color: "#FFFFFF", text: "" } } })).toThrow(/card/);
    expect(() => validateJob({ ...base, interpolateFps: 30 })).toThrow(/interpolateFps/);
    expect(() => validateJob({ ...base, fonts: [{ family: "X", url: "file:///etc/passwd", format: "ttf" }] })).toThrow(/fonts/);
    expect(validateJob({ ...base, interpolateFps: 60 }).interpolateFps).toBe(60);
  });
});

describe("audio-only render (transcription input)", () => {
  it("builds no picture and writes mono 16 kHz MP3 chunks", () => {
    const r = build(job({ audioOnly: { sampleRate: 16000, chunkSeconds: 240 } }), { audioPattern: "/tmp/r/part%03d.mp3" });
    expect(r.filter).not.toMatch(/\[\d+:v\]|color=c=black/);
    expect(r.filter).toContain("aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono[amono]");
    expect(r.args).toEqual(expect.arrayContaining(["-map", "[amono]", "-c:a", "libmp3lame", "-ac", "1", "-f", "segment", "-segment_time", "240"]));
    expect(r.args[r.args.length - 1]).toBe("/tmp/r/part%03d.mp3");
    expect(r.args).not.toContain("[vout]");
  });
});

describe("post-production commands", () => {
  it("extracts the true last frame by decoding to the end into one file", () => {
    const a = lastFrameArgs("https://m/v.mp4", "/tmp/last.png", 1280);
    expect(a).toEqual(expect.arrayContaining(["-sseof", "-1.500", "-update", "1", "-c:v", "png"]));
    expect(a.indexOf("-sseof")).toBeLessThan(a.indexOf("-i"));
    expect(a[a.length - 1]).toBe("/tmp/last.png");
    expect(a.join(" ")).toContain("scale=1280:-2:flags=lanczos");
  });

  it("finds pauses with silencedetect", () => {
    expect(silenceArgs("https://m/vo.m4a", { noiseDb: -40, minSilence: 0.5, start: 2, duration: 10 }).join(" ")).toContain("-ss 2.000 -t 10.000 -i https://m/vo.m4a -vn -sn -af silencedetect=noise=-40dB:d=0.5");
    expect(parseSilences("silence_start: 1.2\nsilence_end: 1.9 | silence_duration: 0.7\nsilence_start: 4.5\n", 5)).toEqual([{ start: 1.2, end: 1.9 }, { start: 4.5, end: 5 }]);
  });

  it("cuts audio and resizes with Lanczos plus a mild sharpen", () => {
    expect(audioCutArgs("https://m/vo.m4a", 1.5, 3, "/tmp/c.m4a").join(" ")).toContain("-ss 1.500 -t 3.000 -i https://m/vo.m4a -vn -sn -c:a aac");
    expect(resizeFilter(2160)).toBe("scale='if(lte(iw,ih),2160,-2)':'if(lte(iw,ih),-2,2160)':flags=lanczos,unsharp=5:5:0.5:5:5:0.0,setsar=1");
    expect(resizeArgs("video", "https://m/v.mp4", 1080, "/tmp/o.mp4")).toEqual(expect.arrayContaining(["-c:a", "copy", "-crf", "18"]));
    expect(resizeArgs("image", "https://m/i.png", 2160, "/tmp/o.png")).toEqual(expect.arrayContaining(["-frames:v", "1", "-c:v", "png"]));
    expect(() => validateResizeJob({ id: "j1", kind: "resize", media: "video", url: "https://m/v.mp4", short: 720 })).toThrow(/short/);
    expect(validateResizeJob({ id: "j1", kind: "resize", media: "image", url: "https://m/v.png", short: 2160 }).short).toBe(2160);
  });
});
