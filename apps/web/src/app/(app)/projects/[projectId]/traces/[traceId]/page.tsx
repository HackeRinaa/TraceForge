import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TraceView } from './trace-view';

export const metadata: Metadata = { title: 'Trace' };

export default async function TracePage({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  return (
    <Suspense>
      <TraceView traceId={traceId} />
    </Suspense>
  );
}
