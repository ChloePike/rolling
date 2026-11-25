/// <reference lib="webworker" />
/**
 * Transfer worker (D-011). As a SharedWorker it owns one queue for every tab
 * of the origin and keeps running while any tab is open; as a dedicated
 * Worker (browsers without SharedWorker, e.g. Chrome Android) it serves one tab.
 */
import { createEngine } from '@/lib/transfers/runtime';
import type { ClientMessage, PortLike } from '@/lib/transfers/types';

declare const SharedWorkerGlobalScope: { prototype: object } | undefined;

const scope = globalThis as unknown as {
  onconnect: ((e: MessageEvent) => void) | null;
  addEventListener: (type: string, cb: (e: Event) => void) => void;
  navigator: Navigator;
};
const isShared = typeof SharedWorkerGlobalScope !== 'undefined' && globalThis instanceof (SharedWorkerGlobalScope as unknown as new () => object);
const engine = createEngine(isShared ? 'shared' : 'dedicated');

interface MessageTarget extends PortLike {
  onmessage: ((e: MessageEvent<ClientMessage>) => void) | null;
  start?: () => void;
}

function attach(port: MessageTarget) {
  const handler = engine.then((e) => e.connect(port));
  port.onmessage = (ev) => {
    void handler.then((h) => h(ev.data));
  };
  port.start?.();
}

scope.addEventListener('online', () => void engine.then((e) => e.setOnline(true)));
scope.addEventListener('offline', () => void engine.then((e) => e.setOnline(false)));

if (isShared) {
  scope.onconnect = (e) => attach(e.ports[0] as unknown as MessageTarget);
} else {
  attach(globalThis as unknown as MessageTarget);
}
