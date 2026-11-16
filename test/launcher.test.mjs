import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Windows launchers start once and stop their recorded server even when PORT changes', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'donkey-mini-launcher-'));
  const entry = path.join(root, 'server', 'index.mjs');
  const sentinel = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: 'unrelated-test-server', pid: process.pid }));
  });
  t.after(async () => {
    await new Promise(resolve => sentinel.close(resolve));
    // A failed assertion must not leave a hidden server running. The command-line
    // check is restricted to this test's unique temporary entry, never production.
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:MINI_TEST_ENTRY) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }'],
    { windowsHide: true, timeout: 15000, env: { ...process.env, MINI_TEST_ENTRY: entry } }).catch(() => {});
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('donkey-mini-launcher-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  await Promise.all(['server', 'public', 'scripts'].map(name => cp(path.join(appRoot, name), path.join(root, name), { recursive: true })));
  const freePort = http.createServer();
  freePort.listen(0, '127.0.0.1');
  await once(freePort, 'listening');
  const port = freePort.address().port;
  await new Promise(resolve => freePort.close(resolve));
  sentinel.listen(0, '127.0.0.1');
  await once(sentinel, 'listening');
  const sentinelPort = sentinel.address().port;
  const env = { ...process.env, PORT: String(port), MINI_DATA_DIR: path.join(root, 'data'), MINI_OUTPUT_DIR: path.join(root, 'output') };
  async function launcher(name, launcherEnv = env) {
    try {
      return await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', name),
        ...(name === 'start.ps1' ? ['-NoBrowser'] : [])], { windowsHide: true, timeout: 25000, env: launcherEnv });
    } catch (error) {
      const log = await readFile(path.join(root, 'data', 'server-error.log'), 'utf8').catch(() => '');
      throw new Error(`Launcher ${name} failed: ${error.stderr || error.message}\n${log}`, { cause: error });
    }
  }
  await launcher('start.ps1');
  const original = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(original.app, 'donkey-studio-mini');
  assert.ok(Number.isInteger(original.pid) && original.pid > 0);
  const metadataPath = path.join(root, 'data', 'launcher.json');
  const metadata = JSON.parse((await readFile(metadataPath, 'utf8')).replace(/^\uFEFF/, ''));
  assert.deepEqual(metadata, { pid: original.pid, port });
  assert.equal(Number((await readFile(path.join(root, 'data', 'server.pid'), 'utf8')).trim()), original.pid);
  await launcher('start.ps1');
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(), original, 'A duplicate launch must reuse the same process.');
  assert.deepEqual(JSON.parse((await readFile(metadataPath, 'utf8')).replace(/^\uFEFF/, '')), metadata);
  await launcher('stop.ps1', { ...env, PORT: String(sentinelPort) });
  let stopped = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(250) }); }
    catch { stopped = true; break; }
    await pause(50);
  }
  assert.ok(stopped, 'The server recorded by the launcher must stop.');
  assert.equal((await (await fetch(`http://127.0.0.1:${sentinelPort}/api/health`)).json()).app, 'unrelated-test-server', 'Changing PORT must not stop an unrelated listener.');
  const remaining = await readdir(path.join(root, 'data'));
  assert.ok(!remaining.includes('server.pid') && !remaining.includes('launcher.json'), 'Stopped launcher metadata must be removed.');
  await launcher('stop.ps1', { ...env, PORT: String(sentinelPort) });
});
