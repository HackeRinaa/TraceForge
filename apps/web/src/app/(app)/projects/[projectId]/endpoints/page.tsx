import type { Metadata } from 'next';
import { EndpointsView } from './endpoints-view';

export const metadata: Metadata = { title: 'Endpoints' };

export default function EndpointsPage() {
  return <EndpointsView />;
}
