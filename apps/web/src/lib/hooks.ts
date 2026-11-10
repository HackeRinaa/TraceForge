'use client';

import type { ProjectDto } from '@traceforge/contracts';
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api, type ApiError, type Params } from './api';
import { scopeToApiParams, useScope } from './scope';

export function useProjectId(): string {
  const { projectId } = useParams<{ projectId: string }>();
  return projectId;
}

export function useProject() {
  const id = useProjectId();
  return useQuery({
    queryKey: ['project', id],
    queryFn: ({ signal }) => api<ProjectDto>(`/v1/projects/${id}`, { signal }),
    staleTime: 60_000,
  });
}

/**
 * Scoped project query: merges the URL's time range and filters, keys the cache by them (so back/forward and shared
 * links are instant and consistent) and refetches on an interval only for relative ranges.
 */
export function useProjectQuery<T>(
  sub: string,
  extra: Params = {},
  options: Partial<Pick<UseQueryOptions<T, ApiError>, 'enabled' | 'refetchInterval'>> & {
    scoped?: boolean;
  } = {},
) {
  const projectId = useProjectId();
  const scope = useScope();
  const { scoped = true, ...rest } = options;
  const params = { ...(scoped ? scopeToApiParams(scope) : {}), ...extra };
  return useQuery<T, ApiError>({
    queryKey: ['p', projectId, sub, params],
    queryFn: ({ signal }) => api<T>(`/v1/projects/${projectId}/${sub}`, { params, signal }),
    // Safety-net polling for relative ranges; the live stream normally refreshes data sooner.
    refetchInterval: scoped && scope.live ? 30_000 : false,
    placeholderData: (previous) => previous,
    ...rest,
  });
}
