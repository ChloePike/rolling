import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { LEGAL_DOCS, type LegalDocId } from './docs';

/** A row of links to the legal pages (Help dialog, Upgrade footer). */
export function LegalLinks({ docs, className, linkClassName, onNavigate }: { docs?: readonly LegalDocId[]; className?: string; linkClassName?: string; onNavigate?: () => void }) {
  const intl = useIntl();
  const list = LEGAL_DOCS.filter((d) => !docs || docs.includes(d.id));
  return (
    <nav aria-label={intl.formatMessage({ id: 'legal.links.label' })} className={className} data-testid="legal-links">
      {list.map((d, i) => (
        <Fragment key={d.id}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <Link to={d.path} className={linkClassName} onClick={onNavigate}>
            <FormattedMessage id={`legal.link.${d.id}`} />
          </Link>
        </Fragment>
      ))}
    </nav>
  );
}
