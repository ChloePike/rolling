/** A recent project, shaped like a `GET /api/projects` row. */
export interface ProjectSummary {
  id: string;
  title: string;
  kind: 'canvas' | 'avatar' | 'quick' | 'character';
  /** Canvas projects: number of nodes. */
  nodeCount?: number;
  /** Video projects: length in seconds. */
  durationSec?: number;
  updatedAt: string;
  /** Cover placeholder tone until thumbnails exist. */
  tone: string;
}
