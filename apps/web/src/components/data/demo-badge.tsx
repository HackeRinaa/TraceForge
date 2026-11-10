'use client';

import { FlaskConical } from 'lucide-react';
import { Badge } from '@/components/ui/panel';
import { useProject } from '@/lib/hooks';

/** Marks projects fed by the bundled demo services so simulated telemetry is never mistaken for production data. */
export function DemoBadge() {
  const project = useProject();
  if (!project.data?.isDemo) return null;
  return (
    <Badge tone="warn" className="gap-1.5 px-2 py-1">
      <FlaskConical className="size-3" aria-hidden />
      DEMO DATA · simulated by the bundled demo services
    </Badge>
  );
}
