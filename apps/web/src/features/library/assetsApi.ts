import { useQuery } from '@tanstack/react-query';
import { assetsMock, charactersMock, foldersMock, storageMock, uploadMock, voicesMock } from './assetsMocks';

/**
 * My assets (`GET /api/assets?scope=mine`, `/api/characters`, `/api/voices`).
 * Mock data until those routes land; keep the hooks, swap the fetchers.
 */
const q = <T>(key: string[], data: T) => ({ queryKey: key, queryFn: async () => structuredClone(data), staleTime: Infinity });

export const useFolders = () => useQuery(q(['assets', 'folders'], foldersMock));
export const useAssets = () => useQuery(q(['assets', 'mine'], assetsMock));
export const useCharacters = () => useQuery(q(['characters'], charactersMock));
export const useVoices = () => useQuery(q(['voices'], voicesMock));
export const useUpload = () => useQuery(q(['assets', 'upload'], uploadMock));
export const useStorage = () => useQuery(q(['assets', 'storage'], storageMock));
