/**
 * How a tab reaches the engine: SharedWorker (one queue per origin) →
 * dedicated Worker (one per tab, same code) → main thread (last resort).
 */
import type { ClientMessage, EngineMessage, TransportMode } from './types';

export interface Transport {
  mode: TransportMode;
  post(msg: ClientMessage): void;
  onMessage(cb: (msg: EngineMessage) => void): void;
  close(): void;
}

export interface TransportOptions {
  /** Force a mode (tests, debugging). */
  force?: TransportMode;
}

export function connectTransport(opts: TransportOptions = {}): Transport {
  const want = opts.force;
  if ((!want || want === 'shared') && typeof SharedWorker !== 'undefined') {
    try {
      const worker = new SharedWorker(new URL('../../workers/transfers.ts', import.meta.url), { type: 'module', name: 'rolling-transfers' });
      const port = worker.port;
      let cb: ((m: EngineMessage) => void) | null = null;
      port.onmessage = (e: MessageEvent<EngineMessage>) => cb?.(e.data);
      port.start();
      return {
        mode: 'shared',
        post: (m) => port.postMessage(m),
        onMessage: (f) => (cb = f),
        close: () => port.close(),
      };
    } catch {
      /* fall through */
    }
  }
  if ((!want || want !== 'main') && typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('../../workers/transfers.ts', import.meta.url), { type: 'module', name: 'rolling-transfers' });
      let cb: ((m: EngineMessage) => void) | null = null;
      worker.onmessage = (e: MessageEvent<EngineMessage>) => cb?.(e.data);
      return {
        mode: 'dedicated',
        post: (m) => worker.postMessage(m),
        onMessage: (f) => (cb = f),
        close: () => worker.terminate(),
      };
    } catch {
      /* fall through */
    }
  }
  return mainThreadTransport();
}

/** Runs the engine in this tab; messages still go through a MessageChannel so semantics match. */
function mainThreadTransport(): Transport {
  const channel = new MessageChannel();
  let cb: ((m: EngineMessage) => void) | null = null;
  channel.port1.onmessage = (e: MessageEvent<EngineMessage>) => cb?.(e.data);
  channel.port1.start();
  const enginePort = channel.port2;
  const ready = import('./runtime').then(async ({ createEngine }) => {
    const engine = await createEngine('main');
    const handle = engine.connect(enginePort);
    enginePort.onmessage = (e: MessageEvent<ClientMessage>) => handle(e.data);
    enginePort.start();
    window.addEventListener('online', () => engine.setOnline(true));
    window.addEventListener('offline', () => engine.setOnline(false));
  });
  void ready;
  return {
    mode: 'main',
    post: (m) => channel.port1.postMessage(m),
    onMessage: (f) => (cb = f),
    close: () => channel.port1.close(),
  };
}
