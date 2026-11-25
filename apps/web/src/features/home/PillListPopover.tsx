import { Presence, type PillPopoverState, type PromptPill } from '../prompt';
import styles from './HomePage.module.css';

export interface PillOption {
  id: string;
  label: string;
}

/**
 * A plain option list for pills that have no shared overlay (the agent LLM,
 * frame mode, avatar persona and voice). Model and generation settings pills
 * use ModelPicker / ParamPopover from `features/overlays`.
 */
export function PillListPopover({
  pill,
  state,
  options,
  value,
  onPick,
}: {
  pill: PromptPill;
  state: PillPopoverState;
  options: PillOption[];
  value: string;
  onPick: (id: string) => void;
}) {
  return (
    <Presence open={state.open} placement={state.placement}>
      <div role="dialog" aria-label={pill.ariaLabel ?? pill.label} className={styles.pillList}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={styles.pillOption}
            aria-pressed={o.id === value}
            onClick={() => {
              onPick(o.id);
              state.close();
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </Presence>
  );
}
