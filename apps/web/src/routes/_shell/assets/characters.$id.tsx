import { createFileRoute } from '@tanstack/react-router';
import { CharacterDetailPage } from '@/features/characters/CharacterDetailPage';

export const Route = createFileRoute('/_shell/assets/characters/$id')({
  component: CharacterRoute,
});

function CharacterRoute() {
  const { id } = Route.useParams();
  return <CharacterDetailPage key={id} id={id} />;
}
