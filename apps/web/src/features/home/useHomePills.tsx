import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import type { PromptSpec } from '@/features/overlays/runs';
import { isMockApi } from '@/features/overlays/backend';
import { pickerModels, useModels, type CatalogModel } from '@/lib/models';
import { usePref } from '@/lib/prefs';
import { useSession } from '@/lib/session';
import { useAgentAllowance } from '@/lib/session/agentAllowance';
import {
  AUTO_MODEL,
  costBlock,
  fitImage,
  fitVideo,
  imageToSettings,
  maxSeconds,
  modelCaps,
  ModelPicker,
  ParamPopover,
  paramOptions,
  strictCredits,
  videoToSettings,
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
/** Ratios the video settings offer; the default aspect ratio preference applies when it is one of them. */
const VIDEO_RATIOS: ReadonlyArray<VideoParams['aspectRatio']> = ['9:16', '16:9', '1:1', '4:3', '3:4'];

/** What the send button runs in a generation mode (the run flow's confirm row). */
export interface HomeRunSpec {
  kind: 'video' | 'image';
  /** e.g. "Seedance 2.5 · 9:16 · 720p · 5s". */
  meta: string;
  modelName: string;
  /** CSS aspect ratio of the result, e.g. "9/16". */
  aspect: string;
  params: Array<{ label: string; value: string }>;
  /** Real mode: what `POST /api/runs/quote { promptSpec }` generates (the page adds the prompt and inputs). */
  spec?: PromptSpec;
}

/**
 * Pills, their popovers and the quote for the Home prompt box. Models and
 * prices come from the synced catalog (`useModels`, D-002); the model pill is
 * always first (handoff 4).
 */
export function useHomePills(
  mode: HomeModeId,
  opts: {
    /** Real mode, Avatar: the voice pill's "Upload a voice track" (the page opens its file chooser). */
    onUploadVoice?: () => void;
  } = {},
): {
  pills: PromptPill[];
  renderPillPopover: (pill: PromptPill, state: PillPopoverState) => ReactNode;
  credits: number | null;
  /** Why the cost line can't show a number (plan lock, unsupported, unpriced); the line shows this instead. */
  blocked: string | null;
  run: HomeRunSpec | null;
} {
  const intl = useIntl();
  const { planId } = useSession();
  const plan = planId ?? undefined;
  const allowance = useAgentAllowance();
  // The default aspect ratio preference (header settings, Settings → Preferences) seeds the video settings.
  const prefRatio = usePref('defaultAspectRatio') as VideoParams['aspectRatio'];
  const seedRatio = <T extends VideoParams>(v: T): T => (VIDEO_RATIOS.includes(prefRatio) ? { ...v, aspectRatio: prefRatio } : v);
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  // Agent turns spend the plan's monthly agent allowance (D-012): each LLM shows the turns it has left.
  const chatAll = useModels('chat').data;
  const chat = useMemo(() => (chatAll ? pickerModels(chatAll, { featuredOnly: true }) : chatAll), [chatAll]);
  const imagesAll = useModels('image').data;
  const images = useMemo(() => (imagesAll ? pickerModels(imagesAll) : imagesAll), [imagesAll]);
  const allVideo = useModels('video').data;
  const videos = useMemo(() => (allVideo ? pickerModels(allVideo).filter((m) => !m.lipSync) : allVideo), [allVideo]);
  const lipSync = allVideo?.filter((m) => m.lipSync);

  const [llmId, setLlmId] = useState<string | null>(null);
  const [agentModel, setAgentModel] = useState<string>(AUTO_MODEL);
  const [agentVideo, setAgentVideo] = useState(() => seedRatio(AGENT_VIDEO));
  const [imageModel, setImageModel] = useState<string | null>(null);
  const [image, setImage] = useState(IMAGE);
  const [videoModel, setVideoModel] = useState<string | null>(null);
  const [video, setVideo] = useState(() => seedRatio(VIDEO));
  const [frame, setFrame] = useState(0);
  const [avatarModel, setAvatarModel] = useState<string | null>(null);
  const [persona, setPersona] = useState(0);
  const [voice, setVoice] = useState(0);

  const pick = (list: CatalogModel[] | undefined, id: string | null) => (id ? list?.find((m) => m.id === id) : undefined) ?? defaultModel(list);

  // PROMPT-2: options follow the selected model's catalog capabilities, not the mode. A value the model
  // lacks refits to the closest one it takes (e.g. Seedance 2.0 Mini offers no 1080p; Seedream 5.0 Flash
  // makes one image per run).
  const videoM = pick(videos, videoModel);
  const agentM = pick(videos, agentModel === AUTO_MODEL ? null : agentModel);
  const imageM = pick(images, imageModel);
  // Mock mode keeps the approved design's option rows (as the tool pages do with DESIGN_CAPS).
  const mockMode = isMockApi();
  const videoCaps = useMemo(() => (mockMode ? null : modelCaps(videoM, 'video')), [videoM, mockMode]);
  const agentCaps = useMemo(() => (mockMode ? null : modelCaps(agentM, 'video')), [agentM, mockMode]);
  const imageCaps = useMemo(() => (mockMode ? null : modelCaps(imageM, 'image')), [imageM, mockMode]);
  useEffect(() => setVideo((v) => fitVideo(v, videoCaps, videoM)), [videoCaps, videoM]);
  useEffect(() => setAgentVideo((v) => fitVideo(v, agentCaps, agentM)), [agentCaps, agentM]);
  useEffect(() => setImage((v) => fitImage(v, imageCaps, imageM)), [imageCaps, imageM]);
  const durationNote = (caps: typeof videoCaps, model?: CatalogModel) => (caps && maxSeconds(caps, model) ? t('home.params.maxSeconds', { n: maxSeconds(caps, model) }) : caps ? null : undefined);
  const nameOf = (list: CatalogModel[] | undefined, id: string | null) =>
    id === AUTO_MODEL ? t('home.pill.autoModel') : (pick(list, id)?.name ?? '');

  const modelPill = (id: string, name: string, modelId?: string): PromptPill => ({
    id,
    kind: 'model',
    icon: 'cube',
    label: name,
    ariaLabel: t('home.pill.modelLabel', { name }),
    modelId,
  });
  const idOf = (list: CatalogModel[] | undefined, id: string | null) => (id === AUTO_MODEL ? undefined : pick(list, id)?.id);

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

  const videoParams = (value: VideoParams, set: (v: VideoParams) => void, cost: number | null, caps: typeof videoCaps, model: CatalogModel | undefined, costBlocked: string | null) => (s: PillPopoverState) => (
    <ParamPopover
      kind="video"
      open={s.open}
      placement={s.placement}
      anchorRef={s.anchorRef}
      value={value}
      onValueChange={(v) => set(fitVideo(v, caps, model))}
      cost={cost ?? undefined}
      costBlocked={costBlocked}
      options={paramOptions(caps)}
      audioSupported={caps ? caps.audio : undefined}
      durationNote={durationNote(caps, model)}
      plan={plan}
      onClose={s.close}
    />
  );

  const list = (pill: PromptPill, options: string[], value: number, set: (i: number) => void, modelIds?: string[], metas?: (string | undefined)[]) => (s: PillPopoverState) => (
    <PillListPopover
      pill={pill}
      state={s}
      value={String(value)}
      options={options.map((label, i) => ({ id: String(i), label, modelId: modelIds?.[i], meta: metas?.[i] }))}
      onPick={(id) => set(Number(id))}
    />
  );

  const secs = (d: VideoParams['duration']) => formatSeconds(intl, parseInt(d, 10));
  const videoQuote = (m: CatalogModel | undefined, v: VideoParams, blockedNow: string | null) => {
    if (blockedNow) return null;
    // The catalog's own price for these settings; never a guess from another resolution.
    const c = m && !mockMode ? strictCredits(m, { resolution: v.resolution, seconds: parseInt(v.duration, 10) }) : quoteCredits(m, { resolution: v.resolution, seconds: parseInt(v.duration, 10) });
    return c === null ? null : c * Number(v.count);
  };

  let specs: PillSpec[] = [];
  let credits: number | null = null;
  let blocked: string | null = null;
  let run: HomeRunSpec | null = null;
  const cssRatio = (r: string) => (r === 'Auto' ? '9/16' : r.replace(':', '/'));

  if (mode === 'agent') {
    const llm = modelPill('model', nameOf(chat, llmId), idOf(chat, llmId));
    const videoModelPill: PromptPill = { id: 'videoModel', kind: 'param', icon: 'film', label: nameOf(videos, agentModel), modelId: idOf(videos, agentModel) };
    const ratio: PromptPill = { id: 'ratio', kind: 'param', icon: 'ratio', label: agentVideo.aspectRatio };
    const duration: PromptPill = { id: 'duration', kind: 'param', icon: 'clock', label: secs(agentVideo.duration) };
    const chatNames = (chat ?? []).map((m) => m.name);
    const params = videoParams(agentVideo, setAgentVideo, null, agentCaps, agentM, null);
    specs = [
      {
        pill: llm,
        render: list(
          llm,
          chatNames,
          Math.max(0, (chat ?? []).findIndex((m) => m.id === pick(chat, llmId)?.id)),
          (i) => setLlmId(chat?.[i]?.id ?? null),
          (chat ?? []).map((m) => m.id),
          (chat ?? []).map((m) => {
            const left = allowance.turnsLeftFor(m.id);
            return left === null ? undefined : t('home.agent.turnsLeft', { count: left });
          }),
        ),
      },
      { pill: videoModelPill, render: modelPicker('video', videos, agentModel, setAgentModel) },
      { pill: ratio, render: params },
      { pill: duration, render: params },
    ];
  } else if (mode === 'image') {
    const m = imageM;
    const ratio: PromptPill = { id: 'ratio', kind: 'param', icon: 'wide', label: image.aspectRatio };
    const size: PromptPill = {
      id: 'size',
      kind: 'param',
      icon: 'res',
      label: t('home.pill.imageSize', { res: image.size, n: Number(image.count) }),
    };
    blocked = costBlock(intl, 'image', m, imageCaps, imageToSettings(image), plan);
    credits = blocked ? null : m && imageCaps ? strictCredits(m, { resolution: image.size, count: Number(image.count) }) : quoteCredits(m, { resolution: image.size, count: Number(image.count) });
    const imageBlocked = blocked;
    const params = (s: PillPopoverState) => (
      <ParamPopover
        kind="image"
        open={s.open}
        placement={s.placement}
        anchorRef={s.anchorRef}
        value={image}
        onValueChange={(v) => setImage(fitImage(v, imageCaps, m))}
        cost={credits ?? undefined}
        costBlocked={imageBlocked}
        options={paramOptions(imageCaps)}
        plan={plan}
        onClose={s.close}
      />
    );
    run = {
      kind: 'image',
      spec: { kind: 'image', model: m?.id ?? 'auto', ratio: image.aspectRatio, resolution: image.size, n: Number(image.count) || 1 },
      modelName: m?.name ?? '',
      meta: [m?.name, image.aspectRatio, size.label].filter(Boolean).join(' · '),
      aspect: cssRatio(image.aspectRatio),
      params: [
        { label: t('home.result.model'), value: m?.name ?? '' },
        { label: t('home.result.aspect'), value: image.aspectRatio },
        { label: t('home.result.size'), value: image.size },
        { label: t('home.result.count'), value: image.count },
      ],
    };
    specs = [
      { pill: modelPill('model', nameOf(images, imageModel), idOf(images, imageModel)), render: modelPicker('image', images, imageModel, setImageModel) },
      { pill: ratio, render: params },
      { pill: size, render: params },
    ];
  } else if (mode === 'video') {
    const m = videoM;
    blocked = costBlock(intl, 'video', m, videoCaps, videoToSettings(video), plan);
    credits = videoQuote(m, video, blocked);
    const frames: PromptPill = { id: 'frames', kind: 'param', icon: 'frame', label: t(`home.pill.${FRAME_MODES[frame]}`) };
    const ratio: PromptPill = {
      id: 'ratio',
      kind: 'param',
      icon: 'ratio',
      label: t('home.pill.videoSize', { ratio: video.aspectRatio, res: video.resolution, seconds: secs(video.duration) }),
    };
    run = {
      kind: 'video',
      spec: { kind: 'video', model: m?.id ?? 'auto', ratio: video.aspectRatio, resolution: video.resolution, seconds: Number.parseInt(String(video.duration), 10) || 5, audio: video.audio },
      modelName: m?.name ?? '',
      meta: [m?.name, video.aspectRatio, video.resolution, secs(video.duration), t(`home.pill.${FRAME_MODES[frame]}`)].filter(Boolean).join(' · '),
      aspect: cssRatio(video.aspectRatio),
      params: [
        { label: t('home.result.model'), value: m?.name ?? '' },
        { label: t('home.result.aspect'), value: video.aspectRatio },
        { label: t('home.result.duration'), value: secs(video.duration) },
        { label: t('home.result.resolution'), value: video.resolution },
      ],
    };
    specs = [
      { pill: modelPill('model', nameOf(videos, videoModel), idOf(videos, videoModel)), render: modelPicker('video', videos, videoModel, setVideoModel) },
      { pill: frames, render: list(frames, FRAME_MODES.map((f) => t(`home.pill.${f}`)), frame, setFrame) },
      { pill: ratio, render: videoParams(video, setVideo, credits, videoCaps, m, blocked) },
    ];
  } else {
    const m = pick(lipSync, avatarModel);
    credits = quoteCredits(m);
    const personaPill: PromptPill = { id: 'persona', kind: 'param', icon: 'person', label: PERSONAS[persona]! };
    const voicePill: PromptPill = { id: 'voice', kind: 'param', icon: 'wave', label: VOICES[voice]! };
    if (!isMockApi()) {
      // Real mode: lip sync to an uploaded voice track (TTS and cloned voices are open decisions); the photo is an `@` picture.
      const uploadPill: PromptPill = { id: 'voice', kind: 'param', icon: 'wave', label: t('home.avatar.uploadVoice') };
      run = {
        kind: 'video',
        spec: { kind: 'avatar', model: m?.id ?? 'auto' },
        modelName: m?.name ?? '',
        meta: [m?.name, t('home.avatar.uploadedVoice')].filter(Boolean).join(' · '),
        aspect: '9/16',
        params: [{ label: t('home.result.model'), value: m?.name ?? '' }],
      };
      specs = [
        { pill: modelPill('model', nameOf(lipSync, avatarModel), idOf(lipSync, avatarModel)), render: modelPicker('avatar', lipSync, avatarModel, setAvatarModel) },
        { pill: uploadPill, render: list(uploadPill, [t('home.avatar.uploadVoice.pick')], -1, () => opts.onUploadVoice?.()) },
      ];
      return {
        pills: specs.map((s) => s.pill),
        renderPillPopover: (pill, state) => specs.find((s) => s.pill.id === pill.id)?.render(state) ?? null,
        credits,
        blocked,
        run,
      };
    }
    run = {
      kind: 'video',
      modelName: m?.name ?? '',
      meta: [m?.name, PERSONAS[persona], VOICES[voice]].filter(Boolean).join(' · '),
      aspect: '9/16',
      params: [
        { label: t('home.result.model'), value: m?.name ?? '' },
        { label: t('home.result.persona'), value: PERSONAS[persona]! },
        { label: t('home.result.voice'), value: VOICES[voice]! },
      ],
    };
    specs = [
      { pill: modelPill('model', nameOf(lipSync, avatarModel), idOf(lipSync, avatarModel)), render: modelPicker('avatar', lipSync, avatarModel, setAvatarModel) },
      { pill: personaPill, render: list(personaPill, PERSONAS, persona, setPersona) },
      { pill: voicePill, render: list(voicePill, VOICES, voice, setVoice) },
    ];
  }

  return {
    pills: specs.map((s) => s.pill),
    renderPillPopover: (pill, state) => specs.find((s) => s.pill.id === pill.id)?.render(state) ?? null,
    credits,
    blocked,
    run,
  };
}
