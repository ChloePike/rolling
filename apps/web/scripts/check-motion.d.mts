export interface MotionProblem {
  file: string;
  line: number;
  found: string;
}
export function scanText(file: string, source: string): MotionProblem[];
export function checkMotion(): { files: number; problems: MotionProblem[] };
