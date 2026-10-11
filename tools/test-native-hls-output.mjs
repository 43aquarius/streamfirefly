import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureFfmpeg } from './fixture-ffmpeg.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exe = process.env.STREAMFIREFLY_NATIVE_EXE || path.join(root, 'native-host/target/debug/streamfirefly-native.exe');
const ffmpeg = process.env.STREAMFIREFLY_FFMPEG_EXE || path.join(root, 'installer/build/x64/ffmpeg.exe');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'streamfirefly-hls-output-'));
const downloads = path.join(temporary, 'downloads');
fs.mkdirSync(downloads);
const sample = path.join(temporary, 'sample.ts');
const generated = spawnSync(fixtureFfmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mpegts', sample], { windowsHide: true });
assert.equal(generated.status, 0, generated.stderr?.toString());
const media = fs.readFileSync(sample);
const key = Buffer.alloc(16, 7);
const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
const encrypted = Buffer.concat([cipher.update(media), cipher.final()]);
const subtitle = Buffer.from('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:00.000 --> 00:00.800\nsubtitle sentinel\n');
const blocked = new Set();
const waiting = [];
const requests = [];
const server = http.createServer((request, response) => {
  requests.push({ url: request.url, proxied: request.headers['x-via-test-proxy'] === '1' });
  const name = request.url.split('/')[1];
  const body = request.url.endsWith('.key') ? key : request.url.endsWith('.vtt') ? subtitle : name === 'proxy-recovery' ? encrypted : media;
  const send = () => { if (!response.destroyed) { response.writeHead(200, { 'Content-Length': body.length }); response.end(body); } };
  if (blocked.has(name) && request.url.endsWith('last.ts')) waiting.push({ name, send });
  else send();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const proxy = http.createServer((request, response) => {
  const forwarded = http.request(new URL(request.url), { method: request.method, headers: { ...request.headers, 'x-via-test-proxy': '1' } }, upstream => {
    response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response);
  });
  forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(forwarded);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const hosts = [];
const barriers = [];
function startHost() {
  const child = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOCALAPPDATA: temporary, PATH: `${path.dirname(ffmpeg)}${path.delimiter}${process.env.PATH}` } });
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  child.stdout.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, size + 4).toString());
      buffer = buffer.subarray(size + 4);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  const send = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Native timeout: ${type}`)); }, 20000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    const bytes = Buffer.from(JSON.stringify({ version: 1, id, type, payload }));
    const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    child.stdin.write(Buffer.concat([header, bytes]));
  });
  const host = { child, send }; hosts.push(host); return host;
}
async function closeHost(host) {
  if (host.child.exitCode !== null) return;
  const exited = once(host.child, 'exit');
  host.child.stdin.end();
  let timer;
  try { assert.equal((await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { host.child.kill(); reject(Error('EOF timeout')); }, 15000); })]))[0], 0); }
  finally { clearTimeout(timer); }
}
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw Error(`Timed out: ${label}`);
}
async function settled(host, id) {
  return until(async () => {
    const task = (await host.send('task.list')).tasks.find(task => task.id === id);
    return ['succeeded', 'partial', 'failed'].includes(task?.state) && task;
  }, `task ${id}`);
}
function release(name) {
  blocked.delete(name);
  for (const entry of waiting.filter(entry => entry.name === name)) entry.send();
}
function payload(name, { subtitles = true, fileName = name } = {}) {
  const manifest = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${name === 'proxy-recovery' ? `#EXT-X-KEY:METHOD=AES-128,URI="${origin}/${name}/media.key",IV=0x${'00'.repeat(16)}\n` : ''}#EXTINF:1,\n${origin}/${name}/first.ts\n#EXTINF:1,\n${origin}/${name}/last.ts\n#EXT-X-ENDLIST\n`;
  return { requestId: randomUUID(), url: `${origin}/${name}/index.m3u8`, fileName, title: name, mime: 'application/vnd.apple.mpegurl', saveDir: downloads, downloadThreads: 1,
    hlsPlan: { version: 2, duration: 2, container: 'mkv', videoManifest: { format: 'hls', baseUrl: `${origin}/${name}/index.m3u8`, text: manifest }, audioManifest: null,
      subtitles: subtitles ? [{ language: 'en', label: 'English', extension: 'vtt', manifest: { format: 'hls', baseUrl: `${origin}/${name}/sub.m3u8`, text: `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\n${origin}/${name}/sub.vtt\n#EXT-X-ENDLIST\n` } }] : [] } };
}
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function subtitleEofRecovery(host) {
  assert.equal(process.platform, 'win32', 'subtitle EOF barrier requires Windows');
  const directory = path.join(temporary, 'subtitle-barrier');
  fs.mkdirSync(directory);
  const watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools/hold-test-subtitle-process.ps1'), '-NativePid', String(host.child.pid), '-ControlDirectory', directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  watcher.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
  const barrier = { watcher, directory, marker: null }; barriers.push(barrier);
  const checkWatcher = () => {
    if (fs.existsSync(path.join(directory, 'error'))) throw Error(fs.readFileSync(path.join(directory, 'error'), 'utf8'));
    if (watcher.exitCode !== null) throw Error(`Subtitle barrier exited early: ${watcher.exitCode} ${diagnostic}`);
  };
  await until(() => { checkWatcher(); return fs.existsSync(path.join(directory, 'ready')); }, 'subtitle barrier ready');
  const request = payload('subtitle-eof');
  // Multiple valid tracks make the short real FFmpeg processes observable without synthetic media.
  request.hlsPlan.subtitles = Array.from({ length: 16 }, (_, index) => ({ ...request.hlsPlan.subtitles[0], label: `English ${index}` }));
  const created = await host.send('task.create', request);
  assert.equal(created.ok, true, JSON.stringify(created));
  const marker = await until(() => {
    checkWatcher();
    if (!fs.existsSync(path.join(directory, 'held.json'))) return false;
    try { return JSON.parse(fs.readFileSync(path.join(directory, 'held.json'), 'utf8')); } catch { return false; }
  }, 'live subtitle FFmpeg');
  barrier.marker = marker;
  assert.equal(marker.parent, host.child.pid);
  assert.match(marker.commandLine, /subtitle-publish-\d+\.vtt/);
  assert.ok(alive(marker.pid), 'subtitle FFmpeg was not alive before EOF');
  const mediaHash = digest(created.task.output);
  await closeHost(host);
  assert.equal(alive(marker.pid), false, 'EOF left the owned subtitle FFmpeg alive');
  await until(() => watcher.exitCode !== null, 'subtitle barrier exit');
  assert.equal(watcher.exitCode, 0, diagnostic);
  const persisted = JSON.parse(fs.readFileSync(path.join(temporary, 'StreamFireFly/tasks.json'), 'utf8')).tasks.find(task => task.id === created.task.id);
  assert.ok(['running', 'interrupted'].includes(persisted.state), `EOF turned subtitle work into terminal partial: ${persisted.state}`);
  assert.equal(persisted.outputs.find(output => output.kind === 'media').state, 'succeeded');
  assert.ok(persisted.outputs.some(output => output.kind === 'subtitle' && output.state !== 'succeeded'));
  assert.ok(fs.existsSync(path.join(temporary, 'StreamFireFly/tasks', created.task.id, 'checkpoint.json')));
  host = startHost();
  const beforeConfiguration = (await host.send('task.list')).tasks.find(task => task.id === created.task.id);
  assert.equal(beforeConfiguration.state, 'interrupted');
  assert.equal((await host.send('network.configure', { mode: 'direct' })).ok, true);
  const resumed = await settled(host, created.task.id);
  assert.equal(resumed.state, 'succeeded', JSON.stringify(resumed));
  assert.equal(digest(resumed.output), mediaHash, 'restart rewrote completed media');
  for (const output of resumed.outputs.filter(output => output.kind === 'subtitle')) {
    assert.equal(output.state, 'succeeded');
    assert.match(fs.readFileSync(output.path, 'utf8'), /WEBVTT[\s\S]*subtitle sentinel/);
  }
  console.log('Real subtitle FFmpeg EOF cleanup and automatic subtitle recovery passed');
  return host;
}
try {
  let host = startHost();
  assert.equal((await host.send('network.configure', { mode: 'direct' })).ok, true);
  fs.writeFileSync(path.join(downloads, 'movie.en.vtt'), 'original subtitle');
  const created = await host.send('task.create', payload('existing', { fileName: 'movie' }));
  assert.equal(created.ok, true, JSON.stringify(created));
  const completed = await settled(host, created.task.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed));
  assert.equal(fs.readFileSync(path.join(downloads, 'movie.en.vtt'), 'utf8'), 'original subtitle');
  const subtitleOutput = completed.outputs.find(output => output.kind === 'subtitle');
  assert.match(fs.readFileSync(subtitleOutput.path, 'utf8'), /WEBVTT[\s\S]*subtitle sentinel/);
  const decoded = spawnSync(fixtureFfmpeg, ['-nostdin', '-v', 'error', '-i', completed.output, '-f', 'null', 'NUL'], { windowsHide: true });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());

  for (const kind of ['media', 'subtitle', 'directory']) {
    const name = `late-${kind}`; blocked.add(name);
    const created = await host.send('task.create', payload(name));
    assert.equal(created.ok, true, JSON.stringify(created));
    await until(() => waiting.some(entry => entry.name === name), 'segment barrier');
    const target = kind === 'subtitle' ? created.task.outputs.find(output => output.kind === 'subtitle').path : created.task.output;
    if (kind === 'directory') fs.mkdirSync(target); else fs.writeFileSync(target, `sentinel-${kind}`);
    release(name);
    const failed = await settled(host, created.task.id);
    assert.equal(failed.error, 'output_path_conflict', JSON.stringify(failed));
    assert.equal(failed.state, kind === 'subtitle' ? 'partial' : 'failed', JSON.stringify(failed));
    assert.equal(failed.message, '输出文件已存在或被其他任务占用，请保留原文件并新建任务。');
    if (kind !== 'directory') assert.equal(fs.readFileSync(target, 'utf8'), `sentinel-${kind}`);
    const mediaHash = kind === 'subtitle' ? digest(failed.output) : null;
    assert.equal((await host.send('task.control', { id: failed.id, action: 'retry' })).ok, true);
    const retried = await settled(host, failed.id);
    assert.equal(retried.error, 'output_path_conflict');
    if (kind === 'subtitle') {
      assert.equal(digest(retried.output), mediaHash, 'successful media was rewritten during subtitle retry');
      fs.renameSync(target, `${target}.preserved`);
      assert.equal((await host.send('task.control', { id: failed.id, action: 'retry' })).ok, true);
      assert.equal((await settled(host, failed.id)).state, 'succeeded');
      assert.equal(digest(failed.output), mediaHash);
      assert.match(fs.readFileSync(target, 'utf8'), /subtitle sentinel/);
    }
  }

  host = await subtitleEofRecovery(host);
  await closeHost(host);
  host = startHost();
  assert.equal((await host.send('network.configure', { mode: 'custom', proxyUrl })).ok, true);
  blocked.add('proxy-recovery');
  const recovering = await host.send('task.create', payload('proxy-recovery', { subtitles: false }));
  assert.equal(recovering.ok, true, JSON.stringify(recovering));
  await until(() => requests.some(entry => entry.url === '/proxy-recovery/last.ts'), 'checkpoint download');
  await closeHost(host);
  host = startHost();
  assert.equal((await host.send('task.list')).ok, true);
  release('proxy-recovery');
  const restartBoundary = requests.length;
  assert.equal((await host.send('network.configure', { mode: 'custom', proxyUrl })).ok, true);
  const resumed = await settled(host, recovering.task.id);
  assert.equal(resumed.state, 'succeeded', JSON.stringify(resumed));
  const recoveredTraffic = requests.slice(restartBoundary);
  assert.ok(recoveredTraffic.some(entry => entry.url.endsWith('.key')), 'recovery did not refetch the key');
  assert.ok(recoveredTraffic.some(entry => entry.url.endsWith('last.ts')));
  assert.ok(requests.filter(entry => entry.url.startsWith('/proxy-recovery/')).every(entry => entry.proxied), 'HLS request bypassed custom proxy');
  await closeHost(host);
  console.log('HLS media/subtitle publication, late conflicts, retry preservation and encrypted HLS proxy recovery passed');
} finally {
  const cleanup = await Promise.allSettled(hosts.filter(host => host.child.exitCode === null).map(closeHost));
  for (const barrier of barriers) {
    fs.writeFileSync(path.join(barrier.directory, 'stop'), 'stop');
    if (barrier.watcher.exitCode === null) await until(() => barrier.watcher.exitCode !== null, 'barrier cleanup');
  }
  server.closeAllConnections(); proxy.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('streamfirefly-hls-output-'));
  fs.rmSync(resolved, { recursive: true, force: true });
  for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
}
