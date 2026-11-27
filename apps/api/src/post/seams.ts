/**
 * Outside calls of post-production, swappable in tests:
 * - Workers AI Whisper (`env.AI`, D-033);
 * - the FFmpeg container's quick commands (`/last-frame`, `/silences`, `/audio-cut`),
 *   on the shared "media" instance. Long work (`/render` audio, `/jobs` resize)
 *   goes through `exports/renderer.ts` from PostWorkflow.
 */
import { container, ContainerUnavailable } from "../queues/mediaProcess";

/** The newest Whisper on Workers AI: word timings, language detection. */
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

export type Whisper = (input: { audio: string; language?: string }) => Promise<unknown>;

let testWhisper: Whisper | null = null;

export function setWhisperForTests(fn: Whisper | null): void {
  testWhisper = fn;
}

/** Whisper on Workers AI, or null when the AI binding is missing (local dev, unit tests). */
export function whisper(env: Env): Whisper | null {
  if (testWhisper) return testWhisper;
  const ai = (env as { AI?: { run: (model: string, input: unknown) => Promise<unknown> } }).AI;
  if (!ai) return null;
  return (input) => ai.run(WHISPER_MODEL, { audio: input.audio, task: "transcribe", ...(input.language && { language: input.language }), condition_on_previous_text: false });
}

export type PostContainer = (env: Env, path: string, body: unknown, timeoutMs?: number) => Promise<Response>;

let call: PostContainer = container;

export function setPostContainerForTests(fn: PostContainer | null): void {
  call = fn ?? container;
}

export function postContainer(): PostContainer {
  return call;
}

export { ContainerUnavailable };

/** Base64 of bytes, chunked (no call-stack limit on large buffers). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
