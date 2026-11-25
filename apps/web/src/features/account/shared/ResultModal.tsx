import { mockVersions, ResultViewer, type ResultAction, type ResultActionId, type ResultParam } from '@/features/overlays';
import { useState } from 'react';

export interface ResultModalItem {
  title: string;
  prompt: string;
  aspect: string;
  kind: 'video' | 'image';
  minutesAgo: number;
  durationSec?: number;
  params: ResultParam[];
}

const VIEW_ACTIONS: ResultAction[] = [{ id: 'edit' }, { id: 'sendToCanvas' }, { id: 'download' }];

/**
 * The shared ResultViewer for results opened from Activity and Profile
 * (`GET /api/runs/:id` → versions and media). Actions are handled by the host.
 */
export function ResultModal({
  item,
  onClose,
  onAction,
  actions = VIEW_ACTIONS,
}: {
  item: ResultModalItem | null;
  onClose: () => void;
  onAction: (id: ResultActionId) => void;
  actions?: ResultAction[];
}) {
  const [version, setVersion] = useState(mockVersions[mockVersions.length - 1]!.id);
  return (
    <ResultViewer
      open={!!item}
      onOpenChange={(o) => !o && onClose()}
      title={item?.title ?? ''}
      author="Alex"
      createdAt={new Date(Date.now() - (item?.minutesAgo ?? 0) * 60_000)}
      aspectRatio={item?.aspect ?? '16/9'}
      mediaKind={item?.kind ?? 'video'}
      versions={mockVersions}
      versionId={version}
      onVersionChange={setVersion}
      durationSec={item?.durationSec ?? 5}
      positionSec={0}
      prompt={item?.prompt ?? ''}
      params={item?.params ?? []}
      assets={[]}
      actions={actions}
      onAction={(id) => onAction(id)}
    />
  );
}
