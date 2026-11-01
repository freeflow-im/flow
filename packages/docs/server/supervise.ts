// Production start command: runs the server and restarts it when it asks to (exit code 75), which it does
// after an app-change job has verified new code. Any other exit ends the container as before. Signals from
// the platform are forwarded so shutdown stays clean.
import { spawn } from 'node:child_process';
import path from 'node:path';

export const RESTART_EXIT_CODE = 75;

const server = path.join(import.meta.dirname, 'index.ts');
let child: ReturnType<typeof spawn> | null = null;
let stopping = false;

function start(): void {
  child = spawn(process.execPath, [server], { stdio: 'inherit', env: { ...process.env, SUPERVISED: '1' } });
  child.on('exit', (code, signal) => {
    child = null;
    if (!stopping && code === RESTART_EXIT_CODE) {
      console.log('[supervise] server asked to restart');
      start();
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    stopping = true;
    child?.kill(sig);
  });
}

start();
