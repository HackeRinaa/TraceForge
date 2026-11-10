'use client';

import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type Tone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  title: string;
  description?: string | undefined;
  tone: Tone;
}
type Notify = (t: { title: string; description?: string | undefined; tone?: Tone }) => void;

const ToastContext = createContext<Notify>(() => undefined);

export function useToast(): Notify {
  return useContext(ToastContext);
}

const TONE_STYLE: Record<Tone, string> = {
  success: 'border-ok/40',
  error: 'border-err/50',
  info: 'border-line-strong',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const notify = useCallback<Notify>(
    ({ title, description, tone = 'info' }) => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-3), { id, title, description, tone }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4500);
    },
    [dismiss],
  );
  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-3 rounded-panel border bg-surface-2 p-3 shadow-lg ${TONE_STYLE[t.tone]}`}
          >
            {t.tone === 'success' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
            ) : t.tone === 'error' ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-err" aria-hidden />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t.title}</p>
              {t.description && <p className="mt-0.5 text-muted">{t.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="rounded p-0.5 text-dim hover:text-text"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
