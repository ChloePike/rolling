import { useId } from 'react';
import { PathIcon, paths } from './Icon';
import styles from './controls.module.css';

interface SearchFieldProps {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/** Pill search field used on Activity, Assets and Public library. */
export function SearchField({ placeholder, value, onChange, className }: SearchFieldProps) {
  const id = useId();
  return (
    <label htmlFor={id} className={className ? `${styles.search} ${className}` : styles.search}>
      <PathIcon d={paths.search} size={15} />
      <input
        id={id}
        type="text"
        role="searchbox"
        className={styles.searchInput}
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
