import { ResultViewer, type ResultAction, type ResultActionId, type ResultParam, type ResultVersion } from '@/features/overlays';
import { useState } from 'react';
import { isMockApi, mockData } from '@/lib/api/mode';
import { useSession } from '@/lib/session';

/** Real results open on their one version (the run's output); mock mode shows the design's v1–v4. */
const ONE_VERSION: ResultVersion[] = [{ id: 'v1', label: 'v1', tone: 'var(--c-tone-blank)' }];

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
  const versions = isMockApi() ? mockData().overlays.mockVersions : ONE_VERSION;
  const [version, setVersion] = useState(versions[versions.length - 1]!.id);
  const { user } = useSession();
  return (
    <ResultViewer
      open={!!item}
      onOpenChange={(o) => !o && onClose()}
      title={item?.title ?? ''}
      author={isMockApi() ? 'Alex' : (user?.name ?? '')}
      createdAt={new Date(Date.now() - (item?.minutesAgo ?? 0) * 60_000)}
      aspectRatio={item?.aspect ?? '16/9'}
      mediaKind={item?.kind ?? 'video'}
      versions={versions}
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
