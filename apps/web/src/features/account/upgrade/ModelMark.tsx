import { modelIcon, ModelIcon } from '@/lib/modelIcons';
import styles from './Upgrade.parts.module.css';

function letters(name: string): string {
  const words = name.split(/[\s.-]+/).filter((w) => w && !/^\d/.test(w));
  return (words.map((w) => w[0]!.toUpperCase()).join('') || name.slice(0, 2)).slice(0, 2);
}

/** A model's provider mark (lib/modelIcons), or its letters when there is none. */
export function ModelMark({ id, name, size = 16 }: { id: string; name: string; size?: number }) {
  const has = !!modelIcon(id);
  return (
    <span className={styles.mark} aria-hidden="true" data-has-logo={has}>
      {has ? <ModelIcon modelId={id} size={size} /> : letters(name)}
    </span>
  );
}
