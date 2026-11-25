import { useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { useModels, type CatalogModel } from '@/lib/models';
import {
  AUTO_MODEL,
  ModelPicker,
  ParamPopover,
  type ImageParams,
  type ModelKind as PickerKind,
  type VideoParams,
} from '@/features/overlays';
import type { PillPopoverState, PromptPill } from '@/features/prompt';
import { defaultModel, quoteCredits, toModelOption } from './catalog';
import { formatSeconds } from './format';
import { FRAME_MODES, PERSONAS, VOICES, type HomeModeId } from './modes';
import { PillListPopover } from './PillListPopover';

interface PillSpec {
  pill: PromptPill;
  render: (state: PillPopoverState) => ReactNode;
}

/** Main.dc.html defaults for each mode's settings. */
const AGENT_VIDEO: VideoParams = { aspectRatio: '9:16', resolution: '720p', duration: '15s', count: '1', audio: false };
const VIDEO: VideoParams = { aspectRatio: '9:16', resolution: '720p', duration: '5s', count: '1', audio: false };
const IMAGE: ImageParams = { aspectRatio: '16:9', quality: 'standard', size: '2K', count: '2' };

/**
 * Pills, their popovers and the quote for the Home prompt box. Models and
 * prices come from the synced catalog (`useModels`, D-002); the model pill is
 * always first (handoff 4).
 */
export function useHomePills(mode: HomeModeId): {
  pills: PromptPill[];
  renderPillPopover: (pill: PromptPill, state: PillPopoverState) => ReactNode;
  credits: number | null;
} {
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const chat = useModels('chat').data;
  const images = useModels('image').data;
  const allVideo = useModels('video').data;
  const videos = allVideo?.filter((m) => !m.lipSync);
  const lipSync = allVideo?.filter((m) => m.lipSync);

  const [llmId, setLlmId] = useState<string | null>(null);
  const [agentModel, setAgentModel] = useState<string>(AUTO_MODEL);
  const [agentVideo, setAgentVideo] = useState(AGENT_VIDEO);
  const [imageModel, setImageModel] = useState<string | null>(null);
  const [image, setImage] = useState(IMAGE);
  const [videoModel, setVideoModel] = useState<string | null>(null);
  const [video, setVideo] = useState(VIDEO);
  const [frame, setFrame] = useState(0);
  const [avatarModel, setAvatarModel] = useState<string | null>(null);
  const [persona, setPersona] = useState(0);
  const [voice, setVoice] = useState(0);

  const pick = (list: CatalogModel[] | undefined, id: string | null) => (id ? list?.find((m) => m.id === id) : undefined) ?? defaultModel(list);
  const nameOf = (list: CatalogModel[] | undefined, id: string | null) =>
    id === AUTO_MODEL ? t('home.pill.autoModel') : (pick(list, id)?.name ?? '');

  const modelPill = (id: string, name: string): PromptPill => ({
    id,
    kind: 'model',
    icon: 'cube',
    label: name,
    ariaLabel: t('home.pill.modelLabel', { name }),
  });

  const modelPicker =
    (kind: PickerKind, list: CatalogModel[] | undefined, value: string | null, set: (id: string) => void) =>
    (s: PillPopoverState) => (
      <ModelPicker
        kind={kind}
        open={s.open}
        placement={s.placement}
        anchorRef={s.anchorRef}
        models={(list ?? []).map(toModelOption)}
        value={value ?? defaultModel(list)?.id ?? AUTO_MODEL}
        onValueChange={(id) => {
          set(id);
          s.close();
        }}
        onClose={s.close}
      />
    );

  const videoParams = (value: VideoParams, set: (v: VideoParams) => void, cost: number | null) => (s: PillPopoverState) => (
    <ParamPopover
      kind="video"
      open={s.open}
      placement={s.placement}
      anchorRef={s.anchorRef}
      value={value}
      onValueChange={set}
      cost={cost ?? undefined}
      onClose={s.close}
    />
  );

  const list = (pill: PromptPill, options: string[], value: number, set: (i: number) => void) => (s: PillPopoverState) => (
    <PillListPopover
      pill={pill}
      state={s}
      value={String(value)}
      options={options.map((label, i) => ({ id: String(i), label }))}
      onPick={(id) => set(Number(id))}
    />
  );

  const secs = (d: VideoParams['duration']) => formatSeconds(intl, parseInt(d, 10));
  const videoQuote = (m: CatalogModel | undefined, v: VideoParams) => {
    const c = quoteCredits(m, { resolution: v.resolution, seconds: parseInt(v.duration, 10) });
    return c === null ? null : c * Number(v.count);
  };

  let specs: PillSpec[] = [];
  let credits: number | null = null;

  if (mode === 'agent') {
    const llm = modelPill('model', nameOf(chat, llmId));
    const videoModelPill: PromptPill = { id: 'videoModel', kind: 'param', icon: 'film', label: nameOf(videos, agentModel) };
    const ratio: PromptPill = { id: 'ratio', kind: 'param', icon: 'ratio', label: agentVideo.aspectRatio };
    const duration: PromptPill = { id: 'duration', kind: 'param', icon: 'clock', label: secs(agentVideo.duration) };
    const chatNames = (chat ?? []).map((m) => m.name);
    const params = videoParams(agentVideo, setAgentVideo, null);
    specs = [
      {
        pill: llm,
        render: list(llm, chatNames, Math.max(0, (chat ?? []).findIndex((m) => m.id === pick(chat, llmId)?.id)), (i) =>
          setLlmId(chat?.[i]?.id ?? null),
        ),
      },
      { pill: videoModelPill, render: modelPicker('video', videos, agentModel, setAgentModel) },
      { pill: ratio, render: params },
      { pill: duration, render: params },
    ];
  } else if (mode === 'image') {
    const m = pick(images, imageModel);
    const ratio: PromptPill = { id: 'ratio', kind: 'param', icon: 'wide', label: image.aspectRatio };
    const size: PromptPill = {
      id: 'size',
      kind: 'param',
      icon: 'res',
      label: t('home.pill.imageSize', { res: image.size, n: Number(image.count) }),
    };
    credits = quoteCredits(m, { resolution: image.size, count: Number(image.count) });
    const params = (s: PillPopoverState) => (
      <ParamPopover
        kind="image"
        open={s.open}
        placement={s.placement}
        anchorRef={s.anchorRef}
        value={image}
        onValueChange={setImage}
        cost={credits ?? undefined}
        onClose={s.close}
      />
    );
    specs = [
      { pill: modelPill('model', nameOf(images, imageModel)), render: modelPicker('image', images, imageModel, setImageModel) },
      { pill: ratio, render: params },
      { pill: size, render: params },
    ];
  } else if (mode === 'video') {
    const m = pick(videos, videoModel);
    credits = videoQuote(m, video);
    const frames: PromptPill = { id: 'frames', kind: 'param', icon: 'frame', label: t(`home.pill.${FRAME_MODES[frame]}`) };
    const ratio: PromptPill = {
      id: 'ratio',
      kind: 'param',
      icon: 'ratio',
      label: t('home.pill.videoSize', { ratio: video.aspectRatio, res: video.resolution, seconds: secs(video.duration) }),
    };
    specs = [
      { pill: modelPill('model', nameOf(videos, videoModel)), render: modelPicker('video', videos, videoModel, setVideoModel) },
      { pill: frames, render: list(frames, FRAME_MODES.map((f) => t(`home.pill.${f}`)), frame, setFrame) },
      { pill: ratio, render: videoParams(video, setVideo, credits) },
    ];
  } else {
    const m = pick(lipSync, avatarModel);
    credits = quoteCredits(m);
    const personaPill: PromptPill = { id: 'persona', kind: 'param', icon: 'person', label: PERSONAS[persona]! };
    const voicePill: PromptPill = { id: 'voice', kind: 'param', icon: 'wave', label: VOICES[voice]! };
    specs = [
      { pill: modelPill('model', nameOf(lipSync, avatarModel)), render: modelPicker('avatar', lipSync, avatarModel, setAvatarModel) },
      { pill: personaPill, render: list(personaPill, PERSONAS, persona, setPersona) },
      { pill: voicePill, render: list(voicePill, VOICES, voice, setVoice) },
    ];
  }

  return {
    pills: specs.map((s) => s.pill),
    renderPillPopover: (pill, state) => specs.find((s) => s.pill.id === pill.id)?.render(state) ?? null,
    credits,
  };
}
