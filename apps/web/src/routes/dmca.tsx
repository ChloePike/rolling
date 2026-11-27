import { createFileRoute } from '@tanstack/react-router';
import { DmcaPage } from '@/features/trust/DmcaPage';

/** Public DMCA takedown notice (D-028). */
export const Route = createFileRoute('/dmca')({ component: DmcaPage });
