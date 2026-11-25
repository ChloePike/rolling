import styles from './controls.module.css';

export function ToolSwitch({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={styles.switch} onClick={onToggle}>
      <span className={styles.knob} />
    </button>
  );
}
