import { createFileRoute } from '@tanstack/react-router';
import { CharacterPage } from '@/features/tools';

export const Route = createFileRoute('/_shell/create/character')({
  // Tool screens fill the area under the header (no page padding).
  staticData: { fullBleed: true },
  component: () => <CharacterPage />,
});
