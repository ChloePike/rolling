/**
 * The mock-mode adapter's registry: the only non-mock module allowed to import
 * mock data (`mockGuard.test.ts`). Loaded on demand by `loadMockData()` in
 * `./mode.ts`, in mock builds and tests only; real builds never include it.
 */
import * as account from '@/features/account/mocks';
import * as admin from '@/features/admin/mocks';
import * as trust from '@/features/trust/mocks';
import * as invite from '@/features/account/invite/mocks';
import * as activity from '@/features/activity/mocks';
import * as canvas from '@/features/canvas/mocks';
import * as editor from '@/features/canvas/editor/mocks';
import * as room from '@/features/canvas/graph/mockRoom';
import * as home from '@/features/home/mocks';
import * as library from '@/features/library/assetsMocks';
import * as overlays from '@/features/overlays/mocks';
import * as profile from '@/features/profile/mocks';
import * as overlayPreview from '@/features/overlays/previewMocks';
import * as prompt from '@/features/prompt/mocks';
import * as templates from '@/features/templates/mocks';
import * as avatar from '@/features/tools/avatar/mocks';
import * as character from '@/features/tools/character/mocks';
import * as quick from '@/features/tools/quick/mocks';
import * as remix from '@/features/tools/remix/mocks';
import * as share from '@/features/share/mocks';
import * as collab from '@/features/collab/mocks';
import * as session from '@/lib/session/mock';

export const mockModules = { account, admin, trust, invite, activity, canvas, editor, room, home, library, overlays, overlayPreview, profile, prompt, share, collab, templates, avatar, character, quick, remix, session };

export type MockData = typeof mockModules;
