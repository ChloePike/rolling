import styles from './controls.module.css';

export function ToolSwitch({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={styles.switch} onClick={onToggle} disabled={disabled}>
      <span className={styles.knob} />
    </button>
  );
}
