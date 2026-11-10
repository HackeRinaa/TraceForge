import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Starts the three demo services as separate processes (each needs its own OpenTelemetry resource so traces cross real
 * process and HTTP boundaries) and forwards their output with a prefix. Ctrl+C stops all of them.
 */
const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
const roles = ['payments', 'inventory', 'gateway'] as const;
const children: ChildProcess[] = [];

for (const role of roles) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: { ...process.env, DEMO_MODE: 'true', DEMO_ROLE: role },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const forward = (stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream) =>
    stream?.on('data', (chunk: Buffer) =>
      out.write(
        chunk
          .toString()
          .replace(/^/gm, `[${role}] `)
          .replace(/\[\w+\] $/, ''),
      ),
    );
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.error(`[launcher] ${role} exited with code ${String(code)}; stopping demo services`);
    stop(code ?? 1);
  });
  children.push(child);
}

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
