/**
 * How a tab reaches the realtime hub (D-014), the same layering as
 * lib/transfers: a SharedWorker (one socket per browser) → the main thread
 * (one socket per tab, where SharedWorker is missing, e.g. Chrome Android).
 * A dedicated Worker would gain nothing over the main thread here: it would
 * still be one socket per tab.
 */
import type { HubMessage, TabMessage } from './protocol';

export type RealtimeTransportMode = 'shared' | 'main';

export interface RealtimeTransport {
  mode: RealtimeTransportMode;
  post(msg: TabMessage): void;
  onMessage(cb: (msg: HubMessage) => void): void;
  close(): void;
}

export function connectRealtime(opts: { force?: RealtimeTransportMode } = {}): RealtimeTransport {
  if (opts.force !== 'main' && typeof SharedWorker !== 'undefined') {
    try {
      const worker = new SharedWorker(new URL('../../workers/realtime.ts', import.meta.url), { type: 'module', name: 'rolling-realtime' });
      const port = worker.port;
      let cb: ((m: HubMessage) => void) | null = null;
      port.onmessage = (e: MessageEvent<HubMessage>) => cb?.(e.data);
      port.start();
      return { mode: 'shared', post: (m) => port.postMessage(m), onMessage: (f) => (cb = f), close: () => port.close() };
    } catch {
      /* fall through */
    }
  }
  return mainThread();
}

/** Runs the hub in this tab; messages still go through a MessageChannel so ordering and async delivery match. */
function mainThread(): RealtimeTransport {
  const channel = new MessageChannel();
  let cb: ((m: HubMessage) => void) | null = null;
  channel.port1.onmessage = (e: MessageEvent<HubMessage>) => cb?.(e.data);
  channel.port1.start();
  const hubPort = channel.port2;
  void import('./hub').then(({ RealtimeHub }) => {
    const hub = new RealtimeHub();
    const handle = hub.connect({ postMessage: (m) => hubPort.postMessage(m) });
    hubPort.onmessage = (e: MessageEvent<TabMessage>) => handle(e.data);
    hubPort.start();
  });
  return { mode: 'main', post: (m) => channel.port1.postMessage(m), onMessage: (f) => (cb = f), close: () => channel.port1.close() };
}
