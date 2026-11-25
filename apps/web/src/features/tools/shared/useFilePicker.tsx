import { useRef, type ReactNode } from 'react';

/**
 * A real file chooser behind any button: render `input` once, call `open()`
 * from the button. The chosen file goes to `onFile` (uploads are mocked until
 * `POST /api/uploads` lands; the caller turns it into a mock asset).
 */
export function useFilePicker(accept: string, onFile: (file: File) => void): { open: () => void; input: ReactNode } {
  const ref = useRef<HTMLInputElement>(null);
  const cb = useRef(onFile);
  cb.current = onFile;
  const input = (
    <input
      ref={ref}
      type="file"
      accept={accept}
      hidden
      data-file-picker=""
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) cb.current(f);
        e.target.value = '';
      }}
    />
  );
  return { open: () => ref.current?.click(), input };
}
