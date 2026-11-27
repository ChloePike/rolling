import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { LEGAL_DOC_IDS, type LegalDocId } from './ids';

/** A row of links to the legal pages (Help dialog, Upgrade footer). */
export function LegalLinks({ docs, className, linkClassName, onNavigate }: { docs?: readonly LegalDocId[]; className?: string; linkClassName?: string; onNavigate?: () => void }) {
  const intl = useIntl();
  const list = LEGAL_DOC_IDS.filter((id) => !docs || docs.includes(id));
  return (
    <nav aria-label={intl.formatMessage({ id: 'legal.links.label' })} className={className} data-testid="legal-links">
      {list.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <Link to={`/${id}`} className={linkClassName} onClick={onNavigate}>
            <FormattedMessage id={`legal.link.${id}`} />
          </Link>
        </Fragment>
      ))}
    </nav>
  );
}
