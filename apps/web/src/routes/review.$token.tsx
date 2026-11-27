import { createFileRoute } from '@tanstack/react-router';
import { ReviewPage } from '@/features/collab/ReviewPage';

/** Public client review link (`<PUBLIC_APP_URL>/review/<token>`, D-031): no account needed. */
export const Route = createFileRoute('/review/$token')({
  component: ReviewRoute,
});

function ReviewRoute() {
  const { token } = Route.useParams();
  return <ReviewPage token={token} />;
}
