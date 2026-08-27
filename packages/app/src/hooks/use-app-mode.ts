import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHost } from '@/providers/host-provider';
import type { AppMode } from '@/lib/host';

export const APP_MODE_QUERY_KEY = ['host', 'app-mode'] as const;

/**
 * The desktop host persists a per-machine choice. Web/console hosts omit
 * the capability and retain the historical developer shell without a prompt.
 */
export function useAppMode() {
  const host = useHost();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: APP_MODE_QUERY_KEY,
    queryFn: () => (host.appMode ? host.appMode.get() : Promise.resolve<AppMode>('developer')),
    staleTime: Infinity,
  });
  const mutation = useMutation({
    mutationFn: async (mode: AppMode) => {
      await host.appMode?.set(mode);
      return mode;
    },
    onMutate: async (mode) => {
      await queryClient.cancelQueries({ queryKey: APP_MODE_QUERY_KEY });
      const previous = queryClient.getQueryData<AppMode | null>(APP_MODE_QUERY_KEY);
      queryClient.setQueryData(APP_MODE_QUERY_KEY, mode);
      return { previous };
    },
    onError: (_error, _mode, context) => {
      queryClient.setQueryData(APP_MODE_QUERY_KEY, context?.previous);
    },
  });

  return {
    mode: query.data,
    isLoading: query.isLoading,
    error: query.error ?? mutation.error,
    isSaving: mutation.isPending,
    setMode: mutation.mutateAsync,
  };
}
