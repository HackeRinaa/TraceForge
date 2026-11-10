'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, registerSchema } from '@traceforge/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/fields';
import { ApiError, api } from '@/lib/api';

type RegisterValues = z.infer<typeof registerSchema>;
type LoginValues = z.infer<typeof loginSchema>;

/** Only same-site relative paths are honoured as post-login destinations, so the redirect cannot leave the app. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [formError, setFormError] = useState<string | null>(null);
  const isRegister = mode === 'register';

  const form = useForm<RegisterValues & LoginValues>({
    resolver: zodResolver(isRegister ? registerSchema : loginSchema) as never,
    defaultValues: { email: '', password: '', name: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api(isRegister ? '/v1/auth/register' : '/v1/auth/login', {
        method: 'POST',
        body: isRegister
          ? { email: values.email, name: values.name, password: values.password }
          : { email: values.email, password: values.password },
      });
      router.push(isRegister ? '/projects' : next);
      router.refresh();
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div>
        <h1 className="text-[16px] font-semibold">
          {isRegister ? 'Create your account' : 'Sign in to TraceForge'}
        </h1>
        <p className="text-muted">
          {isRegister
            ? 'Start with a workspace of your own.'
            : 'Use the account you registered with.'}
        </p>
      </div>
      {isRegister && (
        <Field label="Name" error={errors.name?.message}>
          {(id, d) => (
            <Input
              id={id}
              autoComplete="name"
              aria-describedby={d}
              aria-invalid={!!errors.name}
              {...form.register('name')}
            />
          )}
        </Field>
      )}
      <Field label="Email" error={errors.email?.message}>
        {(id, d) => (
          <Input
            id={id}
            type="email"
            autoComplete="email"
            aria-describedby={d}
            aria-invalid={!!errors.email}
            {...form.register('email')}
          />
        )}
      </Field>
      <Field
        label="Password"
        error={errors.password?.message}
        hint={isRegister ? 'At least 10 characters.' : undefined}
      >
        {(id, d) => (
          <Input
            id={id}
            type="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            aria-describedby={d}
            aria-invalid={!!errors.password}
            {...form.register('password')}
          />
        )}
      </Field>
      {formError && (
        <p role="alert" className="rounded-control bg-err-soft px-3 py-2 text-err-text">
          {formError}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={isSubmitting}>
        {isSubmitting ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
      </Button>
      <p className="text-center text-muted">
        {isRegister ? (
          <>
            Already have an account?{' '}
            <Link href="/login" className="text-accent hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New to TraceForge?{' '}
            <Link href="/register" className="text-accent hover:underline">
              Create an account
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
