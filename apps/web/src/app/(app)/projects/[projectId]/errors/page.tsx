import type { Metadata } from 'next';
import { ErrorsView } from './errors-view';

export const metadata: Metadata = { title: 'Errors' };

export default function ErrorsPage() {
  return <ErrorsView />;
}
