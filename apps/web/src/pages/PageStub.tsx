import type { ReactNode } from 'react';
import { FormattedMessage } from 'react-intl';
import styles from './PageStub.module.css';

interface PageStubProps {
  titleId: string;
  values?: Record<string, ReactNode>;
  /** Hero layout (Home): centered 40px title. */
  hero?: boolean;
  children?: ReactNode;
}

/** Placeholder page that renders only its title. Real screens replace these milestone by milestone. */
export function PageStub({ titleId, values, hero, children }: PageStubProps) {
  return (
    <section className={hero ? styles.hero : styles.page}>
      <h1 className={hero ? styles.heroTitle : styles.title}>
        <FormattedMessage id={titleId} values={values} />
      </h1>
      {children}
    </section>
  );
}
