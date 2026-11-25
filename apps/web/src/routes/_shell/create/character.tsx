import { createFileRoute } from '@tanstack/react-router';
import { CharacterPage } from '../../../features/tools';

export const Route = createFileRoute('/_shell/create/character')({
  component: () => <CharacterPage />,
});
