import * as io from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PIN = Object.freeze({ version: '1.102.4',
  url: 'https://pkgs.tailscale.com/stable/tailscale_1.102.4_amd64.tgz',
  sha256: '50748df1045e60b5b695f19f4c56b0da36c019948b440fb456b6584a50f0d8b9' });
const layout = 'tailscale_1.102.4_amd64';
const execute = promisify(execFile);
const defaults = {
  io, env: process.env, platform: process.platform, arch: process.arch, uid: process.getuid?.(),
  fetch: globalThis.fetch, log: console.log,
  digest: (bytes) => createHash('sha256').update(bytes).digest('hex'),
  pause: () => new Promise(resolve => setTimeout(resolve, 100)),
  proc: async pid => io.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  }),
  run: async (file, args) => (await execute(file, args, { timeout: 30000, maxBuffer: 1048576 })).stdout,
  launch: async (args, log) => {
    const output = await io.open(log, 'a', 0o600);
    try {
      // The root shell execs tailscaled: the written PID is the daemon, NOT sudo.
      const child = spawn('sudo', args, { stdio: ['ignore', output.fd, output.fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { await output.close(); }
  },
};
const dependencies = overrides => ({ ...defaults, ...overrides, digest: overrides?.digest ?? defaults.digest });
const paths = directory => ({ cli: join(directory, layout, 'tailscale'), daemon: join(directory, layout, 'tailscaled'),
  socket: join(directory, 'tailscaled.sock'), pid: join(directory, 'daemon.pid'), token: join(directory, 'token') });
const privateWrite = (d, path, data) => d.io.writeFile(path, data, { mode: 0o600, flag: 'wx' });

async function ownedDirectory(directory, d) {
  const root = await d.io.realpath(d.env.RUNNER_TEMP);
  if (dirname(directory) !== root || !/^agendia-ts-[a-zA-Z0-9_-]+$/.test(basename(directory))) throw Error('TS_OWNERSHIP');
  const stat = await d.io.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== d.uid || (stat.mode & 0o777) !== 0o700 ||
      await d.io.realpath(directory) !== directory) throw Error('TS_OWNERSHIP');
}
async function regular(path, d) {
  const stat = await d.io.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await d.io.realpath(path) !== path) throw Error('TS_BINARY');
}
async function ownedPID(p, d) {
  await regular(p.pid, d);
  const value = await d.io.readFile(p.pid, 'utf8');
  if (!/^[1-9][0-9]*\s*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 1) throw Error('TS_PID');
  const pid = value.trim();
  const argv = (await d.proc(pid)).split('\0').filter(Boolean);
  if (!argv.length) return undefined;
  await regular(p.daemon, d);
  if (argv[0] !== p.daemon || argv.filter(arg => arg.startsWith('--socket=')).join() !== `--socket=${p.socket}` ||
      argv.filter(arg => arg.startsWith('--state=')).join() !== '--state=mem:') throw Error('TS_PID');
  return pid;
}
async function body(url, options, limit, d) {
  const response = await d.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw Error('TS_HTTP');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw Error('TS_HTTP');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export async function cleanup(directory, overrides) {
  if (!directory) return;
  const d = dependencies(overrides); const p = paths(directory);
  let failed = false;
  let stopped = false;
  try { await ownedDirectory(directory, d); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw Error('TS_CLEANUP');
  }
  try {
    const pidfile = await d.io.lstat(p.pid).catch(error => {
      if (error.code === 'ENOENT') return undefined; throw error;
    });
    const pid = pidfile ? await ownedPID(p, d) : undefined;
    if (!pidfile && await d.io.lstat(join(directory, 'daemon.log')).catch(error => { if (error.code !== 'ENOENT') throw error; })) throw Error('TS_PID');
    if (pid) {
      let identity;
      try { identity = await d.io.readFile(join(directory, 'identity'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') failed = true; }
      if (identity === 'attempted') {
        try {
          const socket = await d.io.lstat(p.socket);
          if (!socket.isSocket() || socket.isSymbolicLink() || await d.io.realpath(p.socket) !== p.socket) throw Error('TS_SOCKET');
          await regular(p.cli, d);
          await d.run('sudo', ['-n', p.cli, `--socket=${p.socket}`, 'logout']);
        } catch { failed = true; }
      }
      // Re-prove ownership immediately before each signal; never target a global service.
      if (await ownedPID(p, d) === pid) await d.run('sudo', ['-n', 'kill', '-TERM', '--', pid]);
      for (let attempt = 0; attempt < 50 && await ownedPID(p, d); attempt++) await d.pause();
      if (await ownedPID(p, d) === pid) {
        await d.run('sudo', ['-n', 'kill', '-KILL', '--', pid]);
        for (let attempt = 0; attempt < 50 && await ownedPID(p, d); attempt++) await d.pause();
        if (await ownedPID(p, d)) throw Error('TS_STOP');
      }
    }
    stopped = true;
  } catch { failed = true; }
  if (!stopped) throw Error('TS_CLEANUP');
  try { await ownedDirectory(directory, d); await d.io.rm(directory, { recursive: true }); }
  catch { failed = true; }
  if (failed) throw Error('TS_CLEANUP');
}

export async function connect(overrides) {
  const d = dependencies(overrides); let directory;
  try {
    if (d.platform !== 'linux' || d.arch !== 'x64' || d.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw Error('TS_PLATFORM');
    const client = d.env['INPUT_CLIENT-ID']; const audience = d.env.INPUT_AUDIENCE;
    if (!client || !audience || /[?&\s\x00-\x1f]/.test(client)) throw Error('TS_INPUT');
    const root = await d.io.realpath(d.env.RUNNER_TEMP);
    directory = await d.io.mkdtemp(join(root, 'agendia-ts-'));
    await d.io.chmod(directory, 0o700);
    await ownedDirectory(directory, d);
    await d.io.appendFile(d.env.GITHUB_STATE, `directory=${directory}\n`);
    const p = paths(directory); const archive = join(directory, 'cli.tgz');
    const bytes = await body(PIN.url, {}, 64 * 1024 * 1024, d);
    if (d.digest(bytes) !== PIN.sha256) throw Error('TS_CHECKSUM');
    await privateWrite(d, archive, bytes);
    const listing = (await d.run('tar', ['-tzf', archive])).trim().split('\n');
    const allowed = new Set([`${layout}/`, `${layout}/tailscale`, `${layout}/tailscaled`, `${layout}/systemd/`,
      `${layout}/systemd/tailscaled.defaults`, `${layout}/systemd/tailscaled.service`]);
    if (!listing.every(entry => allowed.has(entry)) || !listing.includes(`${layout}/tailscale`) ||
        !listing.includes(`${layout}/tailscaled`)) throw Error('TS_ARCHIVE');
    await d.run('tar', ['-xzf', archive, '-C', directory, '--no-same-owner', '--no-same-permissions']);
    for (const bin of [p.cli, p.daemon]) { await regular(bin, d); await d.io.chmod(bin, 0o700); }
    if ((await d.run(p.cli, ['version'])).split(/\s/)[0] !== PIN.version) throw Error('TS_VERSION');
    const request = new URL(d.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (request.protocol !== 'https:' || !request.hostname.endsWith('.actions.githubusercontent.com') ||
        request.username || request.password || !d.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw Error('TS_OIDC');
    request.searchParams.set('audience', audience);
    const token = JSON.parse((await body(request, { headers: { Authorization: `Bearer ${d.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } }, 65536, d)).toString()).value;
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw Error('TS_OIDC');
    d.log(`::add-mask::${token.replaceAll('%', '%25')}`);
    await privateWrite(d, p.token, token);
    await privateWrite(d, p.pid, '');
    await privateWrite(d, join(directory, 'daemon.log'), '');
    await d.launch(['-n', 'bash', '-c', 'set -e; echo $$ > "$1"; shift; exec "$@"', '_', p.pid,
      p.daemon, `--socket=${p.socket}`, '--state=mem:'], join(directory, 'daemon.log'));
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        if (await ownedPID(p, d) && (await d.io.lstat(p.socket)).isSocket()) { ready = true; break; }
      } catch (error) { if (error.code !== 'ENOENT' && error.message !== 'TS_PID') throw error; }
      await d.pause();
    }
    if (!ready) throw Error('TS_READY');
    await privateWrite(d, join(directory, 'identity'), 'attempted');
    await d.run('sudo', ['-n', p.cli, `--socket=${p.socket}`, 'up', '--timeout=30s', '--accept-dns=false', '--accept-routes=false',
      '--ssh=false', '--advertise-tags=tag:agendia-ci', `--hostname=agendia-ci-${randomUUID()}`,
      `--client-id=${client}?preauthorized=true&ephemeral=true`, `--id-token=file:${p.token}`]);
    await d.io.unlink(p.token);
    d.log('TS_CONNECTED');
  } catch {
    try { await cleanup(directory, d); } catch { throw Error('TS_SETUP_CLEANUP'); }
    throw Error('TS_SETUP');
  }
}

export function reportFailure() { console.error('TS_ACTION_FAILED'); process.exitCode = 1; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) connect().catch(reportFailure);
