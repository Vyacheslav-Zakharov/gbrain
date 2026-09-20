import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Dedicated process keeps serving while unchanged v7 uses synchronous Git. */
export async function startHttpsGit(repository: string) {
  const directory = mkdtempSync(join(tmpdir(), 'helper-https-'));
  const child = spawn('/usr/bin/python3', [join(import.meta.dir, 'https-git-server.py'), repository, directory], {
    env: { PATH: '/usr/bin:/bin', HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  async function stop() {
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { await exited; } finally { clearTimeout(kill); rmSync(directory, { recursive: true, force: true }); }
  }
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTPS fixture startup timeout')), 25_000);
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        if (/^\d+\n$/.test(output)) { clearTimeout(timer); resolve(Number(output.trim())); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(new Error(`HTTPS fixture exited: ${stderr}`)); });
    });
    return { url: `https://127.0.0.1:${port}/repo.git`, ca: join(directory, 'ca.pem'), directory, pid: child.pid!, stop };
  } catch (error) { await stop(); throw error; }
}
