import type { ActivityEntry, CommentAnchor, PresenceEntry, ReviewDecision, ReviewKind, ReviewLinkState, ReviewStatus, ThreadView } from '@rolling/core/collab';

/** Collaboration (D-031) shapes as `docs/api.md` → Collaboration returns them. */
export type { ActivityEntry, CommentAnchor, PresenceEntry, ReviewDecision, ReviewKind, ReviewLinkState, ReviewStatus, ThreadView };

export interface CollabMember {
  userId: string;
  name: string;
  image: string | null;
  role: string;
}

export interface CommentsState {
  threads: ThreadView[];
  members: CollabMember[];
  unread: number;
  canResolve: boolean;
}

export interface ReviewOwnerView {
  id: string;
  kind: ReviewKind;
  title: string;
  url: string;
  state: ReviewLinkState;
  status: ReviewStatus;
  mature: boolean;
  hasPassword: boolean;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  createdBy: string;
  items: Array<{ id: string; kind: 'image' | 'video' | 'audio'; title: string; nodeId: string | null; versionId: string | null; exportId: string | null; mature: boolean }>;
  decisions: Array<{ reviewerId: string; name: string; email: string | null; decision: ReviewDecision; note: string | null; createdAt: number }>;
}

export type CreateReviewBody =
  | { kind: 'version'; nodeId: string; versionId?: string }
  | { kind: 'export'; exportId: string }
  | { kind: 'shots'; nodeIds: string[] };

export interface ReviewSettings {
  title?: string;
  expiresInDays?: number;
  password?: string;
  confirmMature?: boolean;
}

export interface ReviewPageItem {
  id: string;
  kind: 'image' | 'video' | 'audio';
  title: string;
  mature: boolean;
  media: { url: string | null; posterUrl: string | null } | null;
  withheld: 'mature' | 'missing' | null;
}

export interface ReviewPageData {
  link: { id: string; kind: ReviewKind; title: string; projectTitle: string | null; workspaceName: string | null; expiresAt: number | null; status: ReviewStatus; mature: boolean };
  items: ReviewPageItem[];
  threads: ThreadView[];
  decisions: Array<{ reviewerId: string; name: string; decision: ReviewDecision; note: string | null; createdAt: number }>;
  me: { id: string; name: string; email: string; decision: ReviewDecision | null } | null;
  viewerMatureAllowed: boolean;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  next: number | null;
}
