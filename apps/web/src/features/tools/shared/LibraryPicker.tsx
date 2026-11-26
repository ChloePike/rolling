import type { LibraryCategoryKey } from '@rolling/core/library/types';
import { useIntl } from 'react-intl';
import { useAssetPicker, type AssetPick, type PickKind } from '@/features/picker';
import controls from './controls.module.css';
import { ToolIcon, type ToolIconName } from './icons';
import styles from './LibraryPicker.module.css';

/**
 * An item picked for a preset or look row: from My assets (an upload or a
 * generated asset), a saved Character, or the public library. It goes into
 * the run by asset id (`inputs.referenceAssetIds`, `photoAssetId`, …).
 */
export interface LibraryPick {
  id: string;
  /** The asset the run references (`ast_…`). */
  assetId: string;
  title: string;
  kind: PickKind;
  category: LibraryCategoryKey | null;
  thumbUrl: string | null;
  /** Public items' prompt text (outfits, hairstyles, expressions), added to the run's prompt. */
  promptEn: string | null;
}

export function toPick(p: AssetPick): LibraryPick {
  return { id: p.id, assetId: p.assetId, title: p.name, kind: p.kind, category: p.category ?? null, thumbUrl: p.thumbUrl, promptEn: p.promptEn ?? null };
}

interface RowProps {
  /** Row label and the picker's title, e.g. "Action". */
  label: string;
  /** Public library categories for this row (D-004); the first is preselected. */
  categories: LibraryCategoryKey[];
  /** Kinds the row takes from My assets. Defaults to images. */
  kinds?: PickKind[];
  icon: ToolIconName;
  tone: string;
  value: LibraryPick | null;
  /** Text when nothing is set (a hint, or a mock-mode sample). */
  fallback?: string | null;
  onChange: (item: LibraryPick | null) => void;
  /** Shown as a Clear button next to the row when something is set. */
  onClear?: () => void;
  testId: string;
  /** Data attribute name for the row (`data-preset`, `data-look`). */
  attr?: 'preset' | 'look';
}

/**
 * A `›` row of a tool's left panel. It opens the shared asset picker modal
 * (My assets, Public library on the row's categories, Recent, Upload), never
 * a popover; shows the picked item's thumbnail and name, else "Not set".
 */
export function LibraryRow({ label, categories, kinds = ['image'], icon, tone, value, fallback, onChange, onClear, testId, attr = 'preset' }: RowProps) {
  const intl = useIntl();
  const picker = useAssetPicker();
  const shown = value?.title ?? fallback ?? intl.formatMessage({ id: 'tools.library.notSet' });
  const clear = onClear ?? (value ? () => onChange(null) : undefined);
  const open = async () => {
    const picks = await picker.open({ title: label, kinds, categories, tab: 'public' });
    if (picks?.[0]) onChange(toPick(picks[0]));
  };
  return (
    <div className={styles.row}>
      {picker.element}
      <button
        type="button"
        className={controls.pickRow}
        style={{ flex: 1 }}
        aria-haspopup="dialog"
        aria-expanded={picker.isOpen}
        {...{ [`data-${attr}`]: testId }}
        data-set={value || fallback ? 'true' : 'false'}
        onClick={() => void open()}
      >
        <span className={controls.pickThumb} style={{ background: tone, overflow: 'hidden' }}>
          {value?.thumbUrl ? <img className={styles.rowImg} src={value.thumbUrl} alt="" /> : <ToolIcon name={icon} size={18} color="var(--c-text-2)" />}
        </span>
        <span className={controls.pickText}>
          <span className={controls.pickLabel}>{label}</span>
          <span className={controls.pickValue} style={value || fallback ? undefined : { color: 'var(--c-text-3)' }}>
            {shown}
          </span>
        </span>
        <span className={controls.chev}>›</span>
      </button>
      {clear && value ? (
        <button type="button" className={styles.clear} aria-label={intl.formatMessage({ id: 'tools.library.clearLabel' }, { label })} onClick={clear}>
          {intl.formatMessage({ id: 'tools.library.clear' })}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A row that picks one file from My assets (and uploads into Assets), e.g.
 * the Remix reference video or the Avatar voice track. The value is the asset.
 */
export function AssetRow({ label, kinds, icon, tone, value, empty, onChange, attrs }: { label: string; kinds: PickKind[]; icon: ToolIconName; tone: string; value: { name: string } | null; empty: string; onChange: (pick: AssetPick) => void; attrs?: Record<string, string> }) {
  const picker = useAssetPicker();
  return (
    <>
      {picker.element}
      <button
        type="button"
        className={controls.pickRow}
        aria-haspopup="dialog"
        aria-expanded={picker.isOpen}
        data-set={value ? 'true' : 'false'}
        {...attrs}
        onClick={() =>
          void picker.open({ title: label, kinds, tab: 'mine' }).then((picks) => {
            if (picks?.[0]) onChange(picks[0]);
          })
        }
      >
        <span className={controls.pickThumb} style={{ background: tone }}>
          <ToolIcon name={icon} size={16} color="var(--c-text-2)" />
        </span>
        <span className={controls.pickText}>
          <span className={controls.pickLabel}>{label}</span>
          <span className={controls.pickValue}>{value?.name ?? empty}</span>
        </span>
        <span className={controls.chev}>›</span>
      </button>
    </>
  );
}
