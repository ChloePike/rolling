import { Container } from "@cloudflare/containers";

/**
 * FFmpeg container (containers/ffmpeg). Endpoints: /health, /render, /probe,
 * /thumb, /waveform. Called from ExportWorkflow and the media-process queue.
 */
export class FfmpegRenderer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "5m";
}
