import { Link } from '@tanstack/react-router';
import { FormattedMessage } from 'react-intl';
import { PageStub } from './PageStub';

export function NotFound() {
  return (
    <PageStub titleId="page.notFound.title">
      <p>
        <Link to="/">
          <FormattedMessage id="page.notFound.action" />
        </Link>
      </p>
    </PageStub>
  );
}
