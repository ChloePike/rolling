/**
 * The real API client (docs/api.md). Features call `api.*` (or their own
 * `api.ts` wrappers on top of it); errors are typed `ApiError`s.
 */
export { api, apiRequest, apiUrl, getWorkspaceId, onWorkspaceChange, setWorkspaceId, setFetchForTests, type RequestOptions } from './client';
export { ApiError, errorFromBody, isApiError, type ApiErrorCode, type ApiErrorData, type DataFor } from './errors';
export { apiMode, isMockApi, type ApiMode } from './mode';
export { queryClient } from './queryClient';
export type * from './types';
