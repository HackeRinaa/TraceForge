import type { ReactNode } from 'react';
import { Logo } from '@/components/shell/sidebar';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-panel border border-line bg-surface p-5">{children}</div>
      </div>
    </main>
  );
}
