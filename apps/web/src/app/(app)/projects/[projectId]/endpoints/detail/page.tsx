import type { Metadata } from 'next';
import { Suspense } from 'react';
import { EndpointDetailView } from './detail-view';

export const metadata: Metadata = { title: 'Endpoint' };

export default function EndpointDetailPage() {
  return (
    <Suspense>
      <EndpointDetailView />
    </Suspense>
  );
}
