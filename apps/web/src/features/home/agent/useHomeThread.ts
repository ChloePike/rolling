import { useCallback, useEffect, useRef, useState } from 'react';
import {
  agentFailure,
  applyProposal,
  cancelTurn,
  createThread,
  discardProposal,
  existingThread,
  forgetThread,
  rememberThread,
  sendTurn,
  skillId,
  type AgentFailure,
  type ApplyResult,
  type PlanOption,
  type Proposal,
} from '@/features/overlays/agent';
import { isMockApi } from '@/features/overlays/backend';
import { mockData } from '@/lib/api/mode';
import { resolveAssetId } from '@/lib/transfers';
import { isSmallTalk, messagesFromThread, type ThreadMsg } from './thread';

/** The remembered Home thread (`rolling.agent.thread.home`): reloads continue it. */
export const HOME_THREAD_KEY = 'home';

let seq = 0;
const localId = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface SendInput {
  text: string;
  refs?: string[];
  skill?: string | null;
  llm?: string | null;
}

export interface HomeThread {
  /** Thread id once one exists. */
  id: string | null;
  messages: ThreadMsg[];
  /** A turn is running. */
  busy: boolean;
  /** The stored thread is being read (reload). */
  restoring: boolean;
  send: (input: SendInput) => Promise<void>;
  /** Stops the running turn (partial text stays, no proposal). */
  stop: () => void;
  /** Sends the text of a failed turn again. */
  retry: (msgId: string) => void;
  build: (proposalId: string, optionIndex: number, title?: string) => Promise<ApplyResult>;
  discard: (proposalId: string) => Promise<void>;
  /** Ends this conversation; the next send starts a new thread. */
  reset: () => void;
}

/** What a failure means for the view (`join` is handled by the page: paywall, brief kept). */
export type FailureHandler = (f: AgentFailure, input: SendInput) => { text: string; retryable: boolean } | null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mock mode: a reply streamed word by word, small talk without a plan (the real agent does the same, harness 6). */
async function mockTurn(input: SendInput, onDelta: (d: string) => void): Promise<{ text: string; proposal: Proposal | null }> {
  const m = mockData().home;
  const small = isSmallTalk(input.text);
  const text = small ? m.MOCK_HOME_SMALL_TALK : m.MOCK_HOME_PLAN.text;
  const latency = (window as unknown as { __rollingMocks?: { latencyMs?: number } }).__rollingMocks?.latencyMs ?? 400;
  await wait(latency);
  for (const word of text.split(/(?<= )/)) {
    onDelta(word);
    await wait(Math.max(10, latency / 20));
  }
  if (small) return { text, proposal: null };
  const options = m.MOCK_HOME_PLAN.options as PlanOption[];
  const proposal = {
    id: localId('prop_mock'),
    kind: 'plan',
    status: 'proposed',
    baseRevision: null,
    summary: options[0]!.title,
    createdAt: Date.now(),
    estimate: options[0]!.estimate,
    risks: [],
    body: { kind: 'plan', seconds: 15, refs: [], options },
  } as Proposal;
  return { text, proposal };
}

/**
 * The Home agent conversation (harness 1–2): one AgentSession thread on the
 * `home` surface, remembered in this browser so a reload continues it. Text
 * streams over the user socket (`agent.delta`, D-014) into the pending reply;
 * the turn's plan proposal lands on that reply. Nothing here spends: Build on
 * canvas applies the plan as a new project (free).
 */
export function useHomeThread(onFailure: FailureHandler): HomeThread {
  const mock = isMockApi();
  const [id, setId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(!mock);
  const idRef = useRef<string | null>(null);
  const turnRef = useRef<{ stop: boolean } | null>(null);
  const failRef = useRef(onFailure);
  failRef.current = onFailure;

  // Real mode: the remembered Home thread comes back on load. One that moved to a canvas (its plan was built) is left there.
  useEffect(() => {
    if (mock) return;
    let live = true;
    void existingThread(HOME_THREAD_KEY).then(
      (t) => {
        if (!live) return;
        setRestoring(false);
        if (!t || t.surface !== 'home' || t.projectId) {
          if (t) forgetThread(HOME_THREAD_KEY);
          return;
        }
        idRef.current = t.id;
        setId(t.id);
        setMessages(messagesFromThread(t));
      },
      () => live && setRestoring(false),
    );
    return () => {
      live = false;
    };
  }, [mock]);

  const patchMsg = (msgId: string, fn: (m: ThreadMsg) => ThreadMsg) => setMessages((list) => list.map((m) => (m.id === msgId ? fn(m) : m)));

  const send = useCallback(
    async (input: SendInput) => {
      const text = input.text.trim();
      if (!text || turnRef.current) return;
      const userMsg: ThreadMsg = { id: localId('msg_user'), role: 'user', text, status: 'done' };
      const replyId = localId('msg_agent');
      setMessages((list) => [...list, userMsg, { id: replyId, role: 'agent', text: '', status: 'streaming', tool: null }]);
      setBusy(true);
      const turn = { stop: false };
      turnRef.current = turn;
      const onDelta = (d: string) => !turn.stop && patchMsg(replyId, (m) => ({ ...m, text: m.text + d, tool: null }));
      try {
        if (mock) {
          const r = await mockTurn(input, onDelta);
          if (!turn.stop) patchMsg(replyId, (m) => ({ ...m, text: r.text, status: 'done', proposal: r.proposal }));
          return;
        }
        let threadId = idRef.current;
        if (!threadId) {
          const t = await createThread({ surface: 'home', skill: skillId(input.skill ?? null) });
          threadId = t.id;
          idRef.current = t.id;
          setId(t.id);
          rememberThread(HOME_THREAD_KEY, t.id);
        }
        // `@` uploads still in flight resolve to their asset ids first.
        const refs = input.refs?.length ? (await Promise.all(input.refs.map((r) => resolveAssetId(r)))).filter((r) => r.startsWith('ast_')) : [];
        const r = await sendTurn(threadId, { text, refs, llm: input.llm ?? null }, { onDelta, onTool: (tool) => !turn.stop && patchMsg(replyId, (m) => ({ ...m, tool: tool.status === 'started' ? tool.name : null })) });
        const failed = r.reason === 'error' || (!r.text && !r.proposal && r.reason !== 'canceled');
        if (failed) {
          const shown = failRef.current({ kind: 'error', message: r.error?.message ?? '' }, input);
          patchMsg(replyId, (m) => ({ ...m, text: r.text || shown?.text || '', status: 'error', retryText: text, retryable: true, tool: null }));
          return;
        }
        const safety = r.reason === 'safety_blocked' && !r.text ? failRef.current({ kind: 'error', message: 'safety_blocked' }, input)?.text : null;
        patchMsg(replyId, (m) => ({ ...m, text: r.text || safety || m.text, status: 'done', tool: null, proposal: r.proposal?.kind === 'plan' ? r.proposal : null }));
      } catch (e) {
        const f = agentFailure(e);
        const shown = failRef.current(f, input);
        if (!shown) {
          // The page took it (join paywall): the brief goes back to the prompt box.
          setMessages((list) => list.filter((m) => m.id !== userMsg.id && m.id !== replyId));
          return;
        }
        patchMsg(replyId, (m) => ({ ...m, text: shown.text, status: 'error', retryText: text, retryable: shown.retryable, tool: null }));
      } finally {
        if (turnRef.current === turn) turnRef.current = null;
        setBusy(false);
      }
    },
    [mock],
  );

  const stop = useCallback(() => {
    const turn = turnRef.current;
    if (!turn) return;
    turn.stop = true;
    setMessages((list) => list.map((m) => (m.status === 'streaming' ? { ...m, status: 'done', tool: null } : m)));
    if (!mock && idRef.current) void cancelTurn(idRef.current).catch(() => {});
  }, [mock]);

  const retry = useCallback(
    (msgId: string) => {
      const msg = messages.find((m) => m.id === msgId);
      if (!msg?.retryText) return;
      const at = messages.indexOf(msg);
      // The failed reply and the user message before it are replaced by the new attempt.
      setMessages((list) => list.filter((_, i) => i !== at && !(i === at - 1 && list[i]!.role === 'user')));
      void send({ text: msg.retryText });
    },
    [messages, send],
  );

  const setStatus = (proposalId: string, status: Proposal['status']) =>
    setMessages((list) => list.map((m) => (m.proposal?.id === proposalId ? { ...m, proposal: { ...m.proposal, status } } : m)));

  const build = useCallback(
    async (proposalId: string, optionIndex: number, title?: string): Promise<ApplyResult> => {
      if (mock) {
        setStatus(proposalId, 'applied');
        return { ok: true, proposalId, kind: 'plan' };
      }
      const r = await applyProposal(proposalId, { optionIndex, ...(title ? { title } : {}) });
      setStatus(proposalId, 'applied');
      // The thread moved to the new project (surface canvas): the canvas panel continues it.
      if (r.projectId && idRef.current) rememberThread(`canvas:${r.projectId}`, idRef.current);
      forgetThread(HOME_THREAD_KEY);
      return r;
    },
    [mock],
  );

  const discard = useCallback(
    async (proposalId: string) => {
      setStatus(proposalId, 'discarded');
      if (!mock) await discardProposal(proposalId).catch(() => {});
    },
    [mock],
  );

  const reset = useCallback(() => {
    turnRef.current = null;
    idRef.current = null;
    setId(null);
    setMessages([]);
    setBusy(false);
    forgetThread(HOME_THREAD_KEY);
  }, []);

  return { id, messages, busy, restoring, send, stop, retry, build, discard, reset };
}
