/// <reference lib="webworker" />
/**
 * Realtime SharedWorker (D-014): holds the browser's one WebSocket to
 * `/api/ws` for every tab of the origin (lib/realtime/hub.ts).
 */
import { RealtimeHub } from '@/lib/realtime/hub';
import type { HubMessage, TabMessage } from '@/lib/realtime/protocol';

const scope = globalThis as unknown as { onconnect: ((e: MessageEvent) => void) | null };
const hub = new RealtimeHub();

scope.onconnect = (e) => {
  const port = e.ports[0]!;
  const target = { postMessage: (m: HubMessage) => port.postMessage(m) };
  const handle = hub.connect(target);
  port.onmessage = (ev: MessageEvent<TabMessage>) => {
    if (ev.data?.t === 'bye') hub.disconnect(target);
    else handle(ev.data);
  };
  port.start();
};
