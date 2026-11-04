import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ADMIN_ROOT_KEY } from '../lib/admin.js';

/** A write to the admin API. On success every admin list and figure is fetched again. */
export function useAdminAction(action) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: action,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_ROOT_KEY }),
  });
}
