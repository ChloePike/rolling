/** Prompt editor options (not demo data): mode pill entries and quick modifier choices. */

/** Generation modes per node kind (mode pill). */
export const MODES = {
  video: ['First frame', 'First and last frame', 'Text to video', 'Reference to video'],
  image: ['Text to image', 'Image to image'],
} as const;

/** Options per quick modifier chip; the choice is stored in `params.modifiers`. */
export const QUICK_OPTIONS: Record<string, string[]> = {
  Style: ['Cinematic', 'Documentary', 'Commercial', 'Anime', 'Film grain'],
  Camera: ['Static', 'Slow push-in', 'Pull back', 'Orbit', 'Handheld'],
  Lighting: ['Morning sun', 'Golden hour', 'Soft studio', 'Night neon', 'Overcast'],
  Pace: ['Slow', 'Medium', 'Fast'],
  Framing: ['Close-up', 'Medium', 'Wide', 'Top down'],
};
