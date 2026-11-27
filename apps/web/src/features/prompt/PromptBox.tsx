import { useIndicator } from '@rolling/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useIntl } from 'react-intl';
import { ModelIcon, modelIcon } from '@/lib/modelIcons';
import { promptKeys, refFromPick, uploadKind, uploadReferences } from './api';
import { useAssetPicker } from '@/features/picker';
import { CommandPalette, paletteOptionId } from './CommandPalette';
import { filterCommands, isSlashQuery, stripTrailingAt, trailingAtQuery, COMMAND } from './commands';
import { PromptIcon } from './icons';
import { PlusMenu, type PlusAction } from './PlusMenu';
import { Presence } from './Presence';
import { ReferencePicker } from './ReferencePicker';
import { RefChips, SkillChip } from './RefChips';
import motion from './motion.module.css';
import styles from './PromptBox.module.css';
import type { PromptCommand, PromptCommandGroup, PromptMode, PromptPill, RefItem } from './types';
import { isSendKey } from './keys';

export interface PromptBoxProps {
  /** Prompt text (controlled). */
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  /** Accessible label of the textarea. Defaults to “Brief”. */
  label?: string;
  /** DOM id of the textarea. */
  inputId?: string;

  /** Creation mode tabs shown in the header row (Home). Omit to hide the header. */
  modes?: PromptMode[];
  mode?: string;
  onModeChange?: (id: string) => void;

  /** Model pill first, then parameter pills (handoff 4). */
  pills: PromptPill[];
  /**
   * Renders the popover for a pill (ModelPicker for the model pill,
   * ParamPopover for the others). Called for every pill on every render; the
   * returned layer should animate in/out from `state.open` (both overlay
   * components take an `open` prop). The box anchors it below the pill (above
   * in `dock`), and closes it on Esc / outside click; call `state.close` after a pick.
   */
  renderPillPopover?: (pill: PromptPill, state: PillPopoverState) => ReactNode;

  /** Active skill chip (`/TV ad`). */
  skill?: PromptCommand | null;
  onSkillChange?: (skill: PromptCommand | null) => void;
  /** Skills for the `+` menu. */
  skills?: PromptCommand[];
  /** `/` palette groups. Omit to disable the palette. Use `useDefaultCommandGroups`. */
  commandGroups?: PromptCommandGroup[];
  /**
   * An action command ran (skills and Clear are handled by the box; commands
   * with `pillId` open that pill). The prompt text is cleared first.
   */
  onCommand?: (command: PromptCommand) => void;

  /** Attached references, shown as chips with their source. */
  refs: RefItem[];
  onRefsChange: (refs: RefItem[]) => void;
  /** Items for the `@` picker. Defaults to the mock-backed `useReferences()`. */
  referenceItems?: RefItem[];
  /**
   * Other `+` actions. (`+` → Choose from Assets opens the shared asset picker
   * modal here; `+` → Upload and the `@` picker’s Upload button open the file
   * chooser here; uploads go into the user's Assets, become `mine` references,
   * are added to `refs` and reported through `onUploaded`.)
   */
  onAddAction?: (action: Exclude<PlusAction, 'reference'>) => void;
  /** Files the user uploaded from the box, after they were added to `refs`. */
  onUploaded?: (items: RefItem[]) => void;

  /** The quote next to send: a `<CostLine>`. */
  cost: ReactNode;
  /** Shows “Refine” before the cost (tool pages). */
  onRefine?: () => void;
  onSubmit: () => void;
  /** Accessible name of the send button. Defaults to “Start”. */
  submitLabel?: string;
  submitDisabled?: boolean;

  /**
   * `home`: Main.dc.html (34px pills, chips above the prompt, overlays open below).
   * `dock`: the floating composer of the tool pages (32px pills, Refine, overlays open above).
   */
  variant?: 'home' | 'dock';
  rows?: number;
  className?: string;
}

export interface PillPopoverState {
  open: boolean;
  close: () => void;
  placement: 'below' | 'above';
  /** The pill button; pass as `anchorRef` so outside-click dismissal ignores it. */
  anchorRef: RefObject<HTMLButtonElement | null>;
}

type Overlay = { kind: 'none' } | { kind: 'plus' } | { kind: 'at' } | { kind: 'pill'; id: string };

/**
 * The shared prompt box (handoff 3): modes, model pill first, param pills,
 * `+` menu, `@` references with source chips, `/` commands, Refine, cost and
 * send. The left cluster wraps; the right cluster (Refine, cost, send) never wraps.
 */
export function PromptBox(props: PromptBoxProps) {
  const {
    value,
    onValueChange,
    placeholder,
    modes,
    mode,
    onModeChange,
    pills,
    renderPillPopover,
    skill = null,
    onSkillChange,
    skills = [],
    commandGroups,
    onCommand,
    refs,
    onRefsChange,
    referenceItems,
    onAddAction,
    onUploaded,
    cost,
    onRefine,
    onSubmit,
    submitDisabled,
    variant = 'home',
    rows = variant === 'dock' ? 2 : 3,
    className,
  } = props;
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const uid = useId();
  const inputId = props.inputId ?? `${uid}-brief`;
  const paletteId = `${uid}-palette`;
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const pillRefs = useRef(new Map<string, HTMLButtonElement>());
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' });
  const [active, setActive] = useState(0);
  const modesRef = useRef<HTMLDivElement>(null);
  const modeIndicator = useIndicator(modesRef, mode);

  const slash = !!commandGroups && isSlashQuery(value);
  const groups = slash ? filterCommands(commandGroups!, value.slice(1)) : [];
  const flat = groups.flatMap((g) => g.items);
  const atQuery = trailingAtQuery(value);
  const pickerOpen = overlay.kind === 'at' || atQuery !== null;
  const plusOpen = overlay.kind === 'plus';
  const openPill = overlay.kind === 'pill' ? overlay.id : null;

  const close = () => setOverlay({ kind: 'none' });

  // Outside pointer closes the + menu, a pill popover and the picker.
  useEffect(() => {
    if (overlay.kind === 'none' && atQuery === null) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      if (pickerOpen) closePicker(false);
      else close();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  });

  // Esc closes a pill popover wherever focus is.
  useEffect(() => {
    if (!openPill) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
      pillRefs.current.get(openPill)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openPill]);

  function closePicker(refocus = true) {
    close();
    if (atQuery !== null) onValueChange(stripTrailingAt(value));
    if (refocus) textRef.current?.focus();
  }

  function addRefs(items: RefItem[]) {
    const have = new Set(refs.map((r) => r.id));
    onRefsChange([...refs, ...items.filter((r) => !have.has(r.id))]);
    closePicker();
  }

  function runCommand(c: PromptCommand) {
    setActive(0);
    onValueChange('');
    if (c.kind === 'skill') {
      onSkillChange?.(c);
    } else if (c.id === COMMAND.clear) {
      onSkillChange?.(null);
    } else if (c.pillId && pills.some((p) => p.id === c.pillId)) {
      setOverlay({ kind: 'pill', id: c.pillId });
    }
    if (c.kind === 'action') onCommand?.(c);
    textRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (pickerOpen && e.key === 'Escape') {
      e.preventDefault();
      closePicker();
      return;
    }
    if (pickerOpen && e.key === 'Enter') {
      // The picker owns Enter while it is open (adds the selection).
      const add = rootRef.current?.querySelector<HTMLButtonElement>('[data-picker-add]:not(:disabled)');
      e.preventDefault();
      add?.click();
      return;
    }
    if (slash) {
      const n = flat.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (n ? (i + 1) % n : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (n ? (i - 1 + n) % n : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = flat[Math.min(active, n - 1)];
        if (c) runCommand(c);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onValueChange('');
      }
      return;
    }
    // Enter sends; Shift+Enter inserts a new line; never while an IME is composing (`isSendKey`).
    if (isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) {
      e.preventDefault();
      if (!submitDisabled) onSubmit();
    }
  }

  const togglePlus = () => setOverlay(plusOpen ? { kind: 'none' } : { kind: 'plus' });
  const chooseFiles = () => fileRef.current?.click();
  const assetPicker = useAssetPicker();
  const onFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (fileRef.current) fileRef.current.value = '';
    if (!files.length) return;
    const items = await uploadReferences(files, (f) => {
      const mb = f.size / 1_000_000;
      const size =
        mb >= 1
          ? intl.formatNumber(mb, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })
          : intl.formatNumber(Math.max(1, Math.round(f.size / 1000)), { style: 'unit', unit: 'kilobyte' });
      return intl.formatMessage({ id: 'prompt.upload.meta' }, { kind: uploadKind(f), size });
    });
    // Files over the limits were refused; the transfers dock already said why.
    if (!items.length) return;
    queryClient.setQueryData<RefItem[]>(promptKeys.references, (old) => [...items, ...(old ?? [])]);
    addRefs(items);
    onUploaded?.(items);
  };
  const onPlusAction = (a: PlusAction) => {
    if (a === 'reference') setOverlay({ kind: 'at' });
    else if (a === 'upload') {
      close();
      chooseFiles();
    } else if (a === 'assets') {
      // Choose from Assets: the shared asset picker modal (My assets, Public library, Recent, Upload).
      close();
      void assetPicker.open({ title: t('prompt.plus.assets'), multiple: true }).then((picks) => {
        if (picks?.length) addRefs(picks.map((p, i) => refFromPick(p, i)));
        textRef.current?.focus();
      });
    } else {
      close();
      onAddAction?.(a);
    }
  };

  const dock = variant === 'dock';
  const textarea = (
    <textarea
      ref={textRef}
      id={inputId}
      rows={rows}
      value={value}
      placeholder={placeholder}
      aria-label={props.label ?? t('prompt.brief.label')}
      aria-controls={slash ? paletteId : undefined}
      // No aria-expanded here: a <textarea> (role textbox) may not carry it (axe aria-allowed-attr, critical);
      // the palette is tied to it by aria-controls and aria-activedescendant.
      aria-autocomplete={commandGroups ? 'list' : undefined}
      aria-activedescendant={slash && flat.length ? paletteOptionId(paletteId, active) : undefined}
      className={styles.textarea}
      onChange={(e) => {
        onValueChange(e.target.value);
        setActive(0);
        if (overlay.kind === 'plus') close();
      }}
      onKeyDown={onKeyDown}
    />
  );

  return (
    <div ref={rootRef} className={`${dock ? styles.dock : styles.box} ${className ?? ''}`} data-variant={variant}>
      {assetPicker.element}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        hidden
        data-testid="prompt-upload-input"
        onChange={(e) => void onFiles(e.target.files)}
      />
      {modes?.length ? (
        <div className={styles.head}>
          <div ref={modesRef} role="tablist" aria-label={t('prompt.modes.label')} className={styles.modes}>
            <span className={styles.modeIndicator} style={modeIndicator} aria-hidden="true" />
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={m.id === mode}
                tabIndex={m.id === mode ? 0 : -1}
                className={styles.mode}
                onClick={() => onModeChange?.(m.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  e.preventDefault();
                  const i = modes.findIndex((x) => x.id === mode);
                  const next = modes[(i + (e.key === 'ArrowRight' ? 1 : modes.length - 1)) % modes.length]!;
                  onModeChange?.(next.id);
                  e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-mode="${next.id}"]`)?.focus();
                }}
                data-mode={m.id}
              >
                <PromptIcon name={m.icon} size={15} />
                {m.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className={styles.inner}>
        {skill ? <SkillChip skill={skill} onRemove={() => onSkillChange?.(null)} /> : null}
        {dock ? (
          <div className={styles.dockRow}>
            {refs.map((r, i) => (
              <div
                key={r.id}
                className={`${styles.dockRef} ${motion.chipIn}`}
                data-motion=""
                style={{ background: r.tone }}
                role="img"
                aria-label={intl.formatMessage({ id: 'prompt.ref.numbered' }, { n: i + 1, name: r.name })}
              >
                <span className={styles.dockRefN}>{i + 1}</span>
              </div>
            ))}
            {textarea}
          </div>
        ) : (
          <>
            <RefChips refs={refs} onRemove={(id) => onRefsChange(refs.filter((r) => r.id !== id))} />
            {textarea}
          </>
        )}
        <div className={styles.controls}>
          <div className={styles.left}>
            <button
              ref={plusRef}
              type="button"
              className={styles.plus}
              aria-label={t('prompt.plus.label')}
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              onClick={togglePlus}
            >
              <PromptIcon name="plus" size={dock ? 15 : 16} strokeWidth={2.2} />
            </button>
            {pills.map((p, i) =>
              p.readOnly ? (
                <span key={p.id} className={styles.pillStatic} aria-label={p.ariaLabel} data-pill-static={p.id}>
                  <PromptIcon name={p.icon} size={dock ? 14 : 15} />
                  {p.label}
                </span>
              ) : (
              <span key={p.id} className={styles.pillAnchor}>
                <button
                  ref={(el) => {
                    if (el) pillRefs.current.set(p.id, el);
                    else pillRefs.current.delete(p.id);
                  }}
                  type="button"
                  className={styles.pill}
                  data-model={i === 0 || undefined}
                  aria-label={p.ariaLabel}
                  aria-haspopup={renderPillPopover ? 'dialog' : undefined}
                  aria-expanded={renderPillPopover ? openPill === p.id : undefined}
                  onClick={() => setOverlay(openPill === p.id ? { kind: 'none' } : { kind: 'pill', id: p.id })}
                >
                  {p.modelId && modelIcon(p.modelId) ? (
                    <ModelIcon modelId={p.modelId} size={dock ? 14 : 15} />
                  ) : (
                    <PromptIcon name={p.icon} size={dock ? 14 : 15} />
                  )}
                  {p.label}
                  {i === 0 ? <PromptIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} /> : null}
                </button>
                {renderPillPopover ? (
                  <span className={styles.pillPopover}>
                    {renderPillPopover(p, {
                      open: openPill === p.id,
                      close,
                      placement: dock ? 'above' : 'below',
                      anchorRef: { get current() { return pillRefs.current.get(p.id) ?? null; } },
                    })}
                  </span>
                ) : null}
              </span>
              ),
            )}
          </div>
          <div className={styles.right}>
            {onRefine ? (
              <button type="button" className={styles.refine} aria-label={t('prompt.refine.label')} title={t('prompt.refine.label')} onClick={onRefine}>
                {t('prompt.refine')}
              </button>
            ) : null}
            {cost}
            <button
              type="button"
              className={styles.send}
              aria-label={props.submitLabel ?? t('prompt.send')}
              title={dock ? (props.submitLabel ?? t('prompt.send')) : undefined}
              disabled={submitDisabled}
              onClick={onSubmit}
            >
              <PromptIcon name="arrowUp" size={dock ? 16 : 18} strokeWidth={dock ? 2.8 : 2.6} />
            </button>
          </div>
        </div>

        <Presence open={pickerOpen} className={styles.overlayPanel} placement={dock ? 'above' : 'below'}>
          <ReferencePicker
            query={atQuery ?? ''}
            items={referenceItems}
            onAdd={addRefs}
            onClose={() => closePicker()}
            onUpload={chooseFiles}
            autoFocus={overlay.kind === 'at'}
          />
        </Presence>
        <Presence open={slash} className={styles.overlayPalette} placement={dock ? 'above' : 'below'}>
          <CommandPalette
            id={paletteId}
            groups={groups}
            activeIndex={Math.min(active, Math.max(flat.length - 1, 0))}
            onActiveIndexChange={setActive}
            onRun={runCommand}
          />
        </Presence>
        <Presence open={plusOpen} className={styles.overlayMenu} placement={dock ? 'above' : 'below'}>
          <PlusMenu
            skills={skills}
            activeSkillId={skill?.id}
            onAction={onPlusAction}
            onSkill={(k) => {
              onSkillChange?.(k);
              close();
              textRef.current?.focus();
            }}
            onClose={() => {
              close();
              plusRef.current?.focus();
            }}
          />
        </Presence>
      </div>
    </div>
  );
}
