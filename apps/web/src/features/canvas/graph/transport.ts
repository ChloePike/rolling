/** The part of a WebSocket the sync layer needs; the real socket and the mock both fit. */
export interface Transport {
  send(raw: string): void;
  onMessage(listener: (raw: string) => void): () => void;
  close(): void;
}

/** Adapter for the real ProjectRoom socket (`GET /api/projects/:id/ws`). */
export function webSocketTransport(url: string): Transport {
  const ws = new WebSocket(url);
  const queue: string[] = [];
  ws.addEventListener('open', () => {
    for (const raw of queue.splice(0)) ws.send(raw);
  });
  return {
    send(raw) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      else queue.push(raw);
    },
    onMessage(listener) {
      const handler = (e: MessageEvent) => {
        if (typeof e.data === 'string') listener(e.data);
      };
      ws.addEventListener('message', handler);
      return () => ws.removeEventListener('message', handler);
    },
    close() {
      ws.close();
    },
  };
}
