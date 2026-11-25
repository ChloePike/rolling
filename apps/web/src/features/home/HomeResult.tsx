import { useToast } from '@rolling/ui';
import { useNavigate } from '@tanstack/react-router';
import { useIntl } from 'react-intl';
import { mockResultActions, ResultViewer, type ResultActionId, type ResultVersion, type RunRequest } from '@/features/overlays';
import type { RefItem } from '@/features/prompt';
import { useCreateProject } from './api';
import { assetMediaUrl, isMockApi } from '@/features/overlays/backend';
import { downloadAsset } from '@/features/overlays/media';
import type { PromptSpec } from '@/features/overlays/runs';

export interface HomeResultState {
  title: string;
  prompt: string;
  kind: 'video' | 'image';
  aspect: string;
  modelName: string;
  params: Array<{ label: string; value: string }>;
  refs: RefItem[];
  versions: ResultVersion[];
  versionId: string;
  createdAt: Date;
  cost: number;
  /** Real mode: the spec to regenerate with, and each version's result asset. */
  spec?: PromptSpec;
  assets?: Record<string, string | null>;
}

const TONES = ['var(--c-tone-indigo)', 'var(--c-tone-teal)', 'var(--c-tone-plum)', 'var(--c-tone-sand)'];

/** A new version entry for a finished run. */
export function nextVersion(versions: ResultVersion[], runId: string): ResultVersion {
  const n = versions.length + 1;
  return { id: runId, label: `v${n}`, tone: TONES[(n - 1) % TONES.length] };
}

/** Saves the result's poster as a file (the mock has no media; the real download is a signed media URL, D-008). */
function downloadPoster(name: string, tone: string, aspect: string) {
  // Tones are CSS variables; a standalone file needs the resolved color.
  const v = /^var\((--[\w-]+)\)$/.exec(tone)?.[1];
  const fill = (v ? getComputedStyle(document.documentElement).getPropertyValue(v).trim() : tone) || 'currentColor';
  const [w, h] = aspect.split('/').map(Number);
  const W = 720;
  const H = Math.round((W * (h || 16)) / (w || 9));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${fill}"/></svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.svg`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The result viewer for a Home generation: versions from each run, actions
 * that re-enter the run flow (Regenerate, Extend, HD), open a canvas (Edit
 * from here, Send to canvas) or download.
 */
export function HomeResult({
  result,
  onChange,
  onRun,
}: {
  result: HomeResultState | null;
  onChange: (r: HomeResultState | null) => void;
  /** Starts a paid action through the run flow. */
  onRun: (req: Omit<RunRequest, 'onDone'>, done: (runId: string, assetId?: string | null) => void) => void;
}) {
  const intl = useIntl();
  const toast = useToast();
  const navigate = useNavigate();
  const createProject = useCreateProject();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);

  const onAction = (id: ResultActionId, versionId: string) => {
    if (!result) return;
    const action = mockResultActions.find((a) => a.id === id);
    if (id === 'download') {
      const v = result.versions.find((x) => x.id === versionId);
      const assetId = result.assets?.[versionId];
      if (!isMockApi() && assetId) {
        toast.show({ message: t('overlays.viewer.downloading', { name: result.title }) });
        void downloadAsset(assetId, `${result.title} ${v?.label ?? ''}`.trim()).catch(() => {});
        return;
      }
      const name = `${result.title} ${v?.label ?? ''}`.trim().replace(/[^\w.-]+/g, '-');
      downloadPoster(name, v?.tone ?? TONES[0]!, result.aspect);
      toast.show({ message: t('overlays.viewer.downloading', { name }) });
      return;
    }
    if (id === 'edit' || id === 'sendToCanvas') {
      void createProject({ title: result.title, kind: 'canvas' }).then(({ id: projectId }) => {
        onChange(null);
        void navigate({ to: '/p/$projectId', params: { projectId } });
      });
      return;
    }
    const cost = id === 'regenerate' ? result.cost : (action?.cost ?? 0);
    onRun(
      {
        cost,
        kind: result.kind,
        actionLabel: t(`overlays.viewer.action.${id}`),
        meta: `${result.modelName} · ${result.versions.find((v) => v.id === versionId)?.label ?? ''}`,
        // Only Regenerate has a spec in real mode (Extend and HD are tool actions not on the API yet).
        ...(id === 'regenerate' && result.spec ? { spec: result.spec } : {}),
      },
      (runId, assetId) => {
        const v = nextVersion(result.versions, runId);
        onChange({ ...result, versions: [...result.versions, v], versionId: v.id, createdAt: new Date(), assets: { ...result.assets, [v.id]: assetId ?? null } });
      },
    );
  };

  return (
    <ResultViewer
      open={!!result}
      onOpenChange={(o) => !o && onChange(null)}
      title={result?.title ?? ''}
      author={t('home.result.you')}
      createdAt={result?.createdAt ?? new Date()}
      aspectRatio={result?.aspect ?? '9/16'}
      mediaKind={result?.kind ?? 'video'}
      versions={result?.versions ?? []}
      versionId={result?.versionId ?? ''}
      onVersionChange={(versionId) => result && onChange({ ...result, versionId })}
      src={result?.assets?.[result.versionId] ? assetMediaUrl(result.assets[result.versionId]!) : undefined}
      prompt={result?.prompt ?? ''}
      params={result?.params ?? []}
      assets={(result?.refs ?? []).map((r) => ({ id: r.id, name: r.name, tone: r.tone, thumbnailUrl: r.thumbUrl }))}
      actions={mockResultActions.map((a) => (a.id === 'regenerate' ? { ...a, cost: result?.cost } : a))}
      onAction={onAction}
    />
  );
}
