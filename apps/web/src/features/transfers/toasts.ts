import type { useToast } from '@rolling/ui';
import { useEffect } from 'react';
import type { IntlShape } from 'react-intl';
import { transfers } from '@/lib/transfers';
import { formatBytes } from './format';

/**
 * Kept apart from the dock so the root route can listen from the first render
 * while the dock's UI loads on demand (shell/LazyTransfersDock.tsx).
 */
/** Completion and failure toasts, only in the tab that started the transfer. */
export function useTransferToasts(intl: IntlShape, toast: ReturnType<typeof useToast>) {
  useEffect(() => {
    const offs = [
      transfers.on('transfer.done', (e) => {
        const own = transfers.ownership(e.id);
        if (!own.mine || own.quiet || e.kind === 'fetch') return;
        toast.show({ message: intl.formatMessage({ id: e.kind === 'upload' ? 'transfers.toast.uploaded' : 'transfers.toast.downloaded' }, { name: e.name }) });
      }),
      transfers.on('transfer.failed', (e) => {
        if (!transfers.ownership(e.id).mine || e.kind === 'fetch') return;
        toast.show({
          message: intl.formatMessage({ id: 'transfers.toast.failed' }, { name: e.name }),
          action: { label: intl.formatMessage({ id: 'transfers.action.retry' }), onAction: () => transfers.retry(e.id) },
        });
      }),
      transfers.onRejected((list) => {
        const r = list[0]!;
        const v = r.validation;
        toast.show({ message: intl.formatMessage({ id: `transfers.toast.rejected.${v.reason}` }, { name: r.file.name, max: v.maxBytes ? formatBytes(intl, v.maxBytes) : '' }) });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [intl, toast]);
}
