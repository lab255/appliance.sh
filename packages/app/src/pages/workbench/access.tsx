import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useAppMode } from '@/hooks/use-app-mode';
import { useKeyRole } from '@/hooks/use-key-role';

/** F07 applies only to the two Workbench routes, including direct entry. */
export function RequireWorkbench({ children }: { children: ReactNode }) {
  const { mode, isLoading } = useAppMode();
  const { role, isLoading: roleLoading } = useKeyRole();
  if (isLoading || roleLoading) return null;
  if (mode !== 'developer' || role !== 'admin') return <Navigate to="/apps" replace />;
  return <>{children}</>;
}
