import { useRef, type ReactNode } from 'react';
import { uploadFiles, type UploadResult } from '@/lib/transfers';

/**
 * A real file chooser behind any button: render `input` once, call `open()`
 * from the button. The chosen file starts uploading through the shared
 * transfer queue (D-011, high priority: the tool needs it) and goes to `onFile`
 * at once; `onUploaded` gets the asset when the server has it. Files over the
 * limits are refused (the transfers dock says why) and never reach `onFile`.
 */
export function useFilePicker(
  accept: string,
  /** `uploadId` is the provisional reference id (`upl_…`); `resolveAssetId` turns it into the asset id. */
  onFile: (file: File, uploadId: string) => void,
  onUploaded?: (file: File, result: UploadResult) => void,
): { open: () => void; input: ReactNode } {
  const ref = useRef<HTMLInputElement>(null);
  const cb = useRef(onFile);
  cb.current = onFile;
  const done = useRef(onUploaded);
  done.current = onUploaded;
  const input = (
    <input
      ref={ref}
      type="file"
      accept={accept}
      hidden
      data-file-picker=""
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        const { items } = uploadFiles([f], { purpose: 'tool', priority: 'high', quiet: true });
        if (!items[0]) return;
        cb.current(f, items[0].id);
        void items[0].done.then((r) => done.current?.(f, r));
      }}
    />
  );
  return { open: () => ref.current?.click(), input };
}
