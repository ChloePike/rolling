/** One server-sent event. `data` joins multi-line data fields with `\n`. */
export interface SseEvent {
  event: string | null;
  data: string;
  id: string | null;
}

/**
 * Parses a `text/event-stream` body. Works on any ReadableStream of bytes
 * (Workers and browsers); handles chunks split anywhere, CRLF/CR/LF line ends,
 * comment lines (`: processing`) and multi-line data.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let event: string | null = null;
  let id: string | null = null;
  let finished = false;

  const dispatch = (): SseEvent | null => {
    if (data.length === 0) {
      event = null;
      return null;
    }
    const out: SseEvent = { event, data: data.join('\n'), id };
    data = [];
    event = null;
    return out;
  };

  const handleLine = (line: string): SseEvent | null => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Split on any line end; keep a trailing partial line (and a lone trailing CR,
      // which may be the first half of CRLF) in the buffer.
      let match: RegExpExecArray | null;
      const lineEnd = /\r\n|\n|\r(?!$)/g;
      let start = 0;
      while ((match = lineEnd.exec(buffer)) !== null) {
        const ev = handleLine(buffer.slice(start, match.index));
        start = match.index + match[0].length;
        if (ev) yield ev;
      }
      buffer = buffer.slice(start);
      if (done) {
        if (buffer !== '') {
          const ev = handleLine(buffer.replace(/\r$/, ''));
          if (ev) yield ev;
        }
        finished = true;
        const last = dispatch();
        if (last) yield last;
        return;
      }
    }
  } finally {
    // Consumer stopped early: cancel the body so the connection is freed.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
