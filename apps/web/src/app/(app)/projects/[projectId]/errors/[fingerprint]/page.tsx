import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ErrorDetailView } from './error-detail-view';

export const metadata: Metadata = { title: 'Error' };

export default async function ErrorDetailPage({
  params,
}: {
  params: Promise<{ fingerprint: string }>;
}) {
  const { fingerprint } = await params;
  return (
    <Suspense>
      <ErrorDetailView fingerprint={fingerprint} />
    </Suspense>
  );
}
