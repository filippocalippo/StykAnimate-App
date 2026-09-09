'use strict';

/** Windows-installed VFW codecs execute in a fixed, isolated native helper. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');

const CHUNK = 256 * 1024, MAX_FRAME = 64 * 1024 * 1024, MAX_OUTPUT = 256 * 1024 * 1024, MAX_STATE = 1024 * 1024;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {}); return {promise, resolve, reject}; };
function integer(value, min, max, label) { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`); return value; }
function dimensions(options = {}) {
  const width = integer(options.width ?? 640, 1, 16384, 'Video width'), height = integer(options.height ?? 480, 1, 16384, 'Video height');
  if (width * height > 16 * 1024 * 1024) throw new Error('Video exceeds the 16-million-pixel limit.');
  const stride = Math.ceil(width * 3 / 4) * 4, frameBytes = stride * height;
  if (frameBytes > MAX_FRAME) throw new Error('A video frame exceeds the 64 MiB limit.');
  return {width, height, stride, frameBytes};
}
function codecIdentity(id) {
  const match = /^vfw:(x86|x64):([0-9a-f]{8})$/i.exec(id ?? '');
  if (!match) throw new Error('Choose an installed Windows VFW codec.');
  return {arch: match[1].toLowerCase(), handler: parseInt(match[2], 16)};
}
function rationalFPS(fps) {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 1 || fps > 1000) throw new Error('Video frame rate must be from 1 to 1000.');
  let numerator = Math.round(fps * 1000000), denominator = 1000000, a = numerator, b = denominator;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  numerator /= a; denominator /= a; return {numerator, denominator};
}
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 512);

class VfwExportService {
  constructor({helperPaths = {}, tempRoot = path.join(os.tmpdir(), 'stykanimate-vfw'), platform = process.platform} = {}) {
    this.helperPaths = {...helperPaths}; this.tempRoot = path.resolve(tempRoot); this.platform = platform;
    this.jobs = new Map(); this.configurations = new Map(); this.cache = new Map(); this.commands = new Set(); this.disposed = false;
  }
  _helper(arch) {
    if (this.disposed) throw new Error('Windows codec service is closed.');
    if (this.platform !== 'win32') throw new Error('Installed Video for Windows codecs are available only in the Windows desktop app.');
    const helper = this.helperPaths[arch]; if (!helper || !path.isAbsolute(helper)) throw new Error(`The ${arch} Windows codec helper is not bundled.`);
    return helper;
  }
  async _command(arch, args, {interactive = false} = {}) {
    const helper = this._helper(arch); await fs.access(helper);
    return new Promise((resolve, reject) => {
      const child = spawn(helper, args.map(String), {windowsHide: !interactive, stdio: ['ignore', 'pipe', 'pipe']}); this.commands.add(child);
      let stdout = '', stderr = '', settled = false;
      const timer = setTimeout(() => fail(new Error(interactive ? 'The codec configuration dialog timed out.' : 'The installed codec query timed out.')), interactive ? 15 * 60 * 1000 : 15000);
      const fail = error => { if (settled) return; settled = true; clearTimeout(timer); this.commands.delete(child); child.kill(); reject(error); };
      child.on('error', fail);
      child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); if (stdout.length > 2 * 1024 * 1024) fail(new Error('Windows codec response exceeds the supported limit.')); });
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-16000); });
      child.on('close', code => {
        if (settled) return; settled = true; clearTimeout(timer); this.commands.delete(child);
        if (code !== 0) return reject(new Error(clean(stderr) || `Windows codec helper exited with code ${code}.`));
        try { const value = JSON.parse(stdout.trim()); if (value.type === 'error') throw new Error(value.message); resolve(value); } catch (error) { reject(new Error(`Invalid Windows codec response: ${error.message}`)); }
      });
    });
  }
  async capabilities(options = {}) {
    const size = dimensions(options), limits = {maxChunkBytes: CHUNK, maxFrameBytes: MAX_FRAME, maxBytes: MAX_OUTPUT, maxStateBytes: MAX_STATE};
    if (this.platform !== 'win32') return {available: false, platform: this.platform, codecs: [], reason: 'Installed Video for Windows codecs require the Windows desktop app.', ...limits};
    const cacheKey = `${size.width}:${size.height}`, cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < 10000) return cached.value;
    const responses = await Promise.allSettled(['x86', 'x64'].map(async arch => ({arch, data: await this._command(arch, ['--list', size.width, size.height])})));
    const codecs = [], errors = [];
    for (const response of responses) {
      if (response.status === 'rejected') { errors.push(clean(response.reason?.message)); continue; }
      const {arch, data} = response.value;
      if (!Array.isArray(data.codecs) || data.codecs.length > 4096) { errors.push(`${arch} codec table is invalid.`); continue; }
      for (const entry of data.codecs) {
        const handler = typeof entry.handler === 'string' ? parseInt(entry.handler, 16) : entry.handler;
        if (!Number.isInteger(handler) || handler < 0 || handler > 0xffffffff) continue;
        const flags = Number(entry.flags) >>> 0, supported = Boolean(entry.supported ?? entry.canCompressRGB24);
        const name = clean(entry.description || entry.name || entry.fourcc), id = `vfw:${arch}:${handler.toString(16).padStart(8, '0')}`;
        codecs.push({id, arch, handler, name, label: `${name} (${arch === 'x86' ? '32' : '64'}-bit)`, fourcc: clean(entry.fourcc), supported, kind: entry.kind ?? 'installed', lossless: entry.kind === 'uncompressed',
          reason: supported ? null : clean(entry.reason || `This codec does not accept ${size.width} × ${size.height} RGB24 frames.`),
          quality: Boolean(entry.quality ?? (flags & 1)), configure: Boolean(entry.configure ?? entry.configureAvailable), keyframes: Boolean(entry.keyframes ?? (flags & 4)), dataRate: Boolean(entry.dataRate ?? (flags & 2)),
          mimeType: 'video/x-msvideo', extension: 'avi', provider: 'Windows VFW'});
      }
    }
    const value = {available: codecs.some(codec => codec.supported), platform: 'win32', codecs, errors, width: size.width, height: size.height,
      reason: codecs.some(codec => codec.supported) ? null : errors.length ? errors.join(' ') : 'No installed Windows codec accepts this RGB24 canvas size.', ...limits};
    if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(cacheKey, {time: Date.now(), value}); return value;
  }
  async _codec(options) {
    const identity = codecIdentity(options.codecId), caps = await this.capabilities(options), codec = caps.codecs.find(codec => codec.id === options.codecId.toLowerCase());
    if (!codec?.supported) throw new Error(codec?.reason || caps.reason || 'This installed Windows codec is unavailable.');
    return {...identity, codec};
  }
  async configure(options = {}, ownerHwnd = '0') {
    const size = dimensions(options), {arch, handler, codec} = await this._codec(options);
    if (!codec.configure) throw new Error('This Windows codec has no configuration dialog.');
    if (!/^\d{1,20}$/.test(String(ownerHwnd))) throw new Error('Invalid codec dialog owner.');
    await fs.mkdir(this.tempRoot, {recursive: true}); const directory = await fs.mkdtemp(path.join(this.tempRoot, 'settings-')), stateFile = path.join(directory, 'codec.state');
    try {
      if (options.configurationId) { const previous = this._configuration(options.configurationId, options.codecId); await fs.copyFile(previous.path, stateFile); }
      await this._command(arch, ['--configure', handler, size.width, size.height, ownerHwnd, stateFile], {interactive: true});
      const stat = await fs.stat(stateFile); if (stat.size > MAX_STATE) throw new Error('Codec settings exceed the 1 MiB limit.');
      const configurationId = randomUUID(); this.configurations.set(configurationId, {codecId: options.codecId, path: stateFile, directory});
      while (this.configurations.size > 16) { const first = this.configurations.keys().next().value, old = this.configurations.get(first); this.configurations.delete(first); await fs.rm(old.directory, {recursive: true, force: true}); }
      return {configurationId, stateBytes: stat.size, codecId: options.codecId};
    } catch (error) { await fs.rm(directory, {recursive: true, force: true}); throw error; }
  }
  _configuration(id, codecId) {
    const configuration = this.configurations.get(id); if (!configuration || configuration.codecId !== codecId) throw new Error('The selected codec settings have expired or belong to another codec.');
    return configuration;
  }
  _job(token) { const job = this.jobs.get(token); if (!job) throw new Error('This Windows video export is no longer active.'); if (job.error) throw job.error; return job; }
  _fail(job, error) {
    if (job.error) return; job.error = error; job.ready.reject(error); job.completion.reject(error); job.frame?.ack.reject(error); job.child?.kill();
  }
  async begin(options = {}) {
    if (this.starting || this.jobs.size) throw new Error('Finish or cancel the current Windows video export first.');
    this.starting = true;
    try { return await this._begin(options); } finally { this.starting = false; }
  }
  async _begin(options) {
    const size = dimensions(options), {numerator, denominator} = rationalFPS(options.fps), totalFrames = integer(options.totalFrames, 1, 1000000, 'Video frame count');
    const quality = options.quality ?? .9; if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1) throw new Error('Video quality must be from zero to one.');
    const keyframeEvery = integer(options.keyframeEvery ?? 0, 0, 1000000, 'Keyframe interval'), bitrate = integer(options.bitrate ?? 0, 0, 200000000, 'Video bitrate');
    const {arch, handler, codec} = await this._codec(options), settings = options.configurationId ? this._configuration(options.configurationId, options.codecId).path : null;
    await fs.mkdir(this.tempRoot, {recursive: true}); const directory = await fs.mkdtemp(path.join(this.tempRoot, 'export-')), outputPath = path.join(directory, 'animation.avi'), token = randomUUID();
    const job = {token, directory, outputPath, ...size, totalFrames, fps: options.fps, codecId: options.codecId, written: 0, read: 0, frame: null, ready: deferred(), completion: deferred(), error: null, complete: null}; this.jobs.set(token, job);
    try {
      const args = ['--encode', outputPath, handler, size.width, size.height, numerator, denominator, totalFrames, codec.quality ? Math.round(quality * 10000) : -1, codec.keyframes ? keyframeEvery : 0, codec.dataRate ? Math.round(bitrate / 8) : 0]; if (settings) args.push(settings);
      const child = job.child = spawn(this._helper(arch), args.map(String), {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      let pending = '', stderr = ''; child.on('error', error => this._fail(job, error)); child.stdin.on('error', error => this._fail(job, error));
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-16000); });
      child.stdout.on('data', bytes => {
        pending += bytes.toString('utf8'); if (pending.length > 128 * 1024) return this._fail(job, new Error('Windows codec protocol response is too large.'));
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1); if (!line) continue;
          try {
            const message = JSON.parse(line), type = message.type ?? message.event;
            if (type === 'ready') { if (message.stride !== size.stride || message.frameBytes !== size.frameBytes) throw new Error('Windows codec input dimensions do not match.'); job.ready.resolve(); }
            else if (type === 'frame') { if (!job.frame || message.index !== job.frame.index) throw new Error('Windows codec acknowledged an unexpected frame.'); if (message.bytesWritten > MAX_OUTPUT) throw new Error('Video output exceeds the 256 MiB limit.'); job.frame.ack.resolve(message); }
            else if (type === 'complete') job.complete = message;
            else throw new Error(message.message || 'Windows codec returned an unknown response.');
          } catch (error) { this._fail(job, error); }
        }
      });
      child.on('close', code => {
        if (job.error) return;
        if (code !== 0 || !job.complete || job.complete.frames !== totalFrames) return this._fail(job, new Error(clean(stderr) || `Windows codec export stopped before completion (code ${code}).`));
        job.completion.resolve(job.complete);
      });
      job.timer = setTimeout(() => this._fail(job, new Error('Windows codec export timed out.')), 30 * 60 * 1000);
      await Promise.race([job.ready.promise, new Promise((_, reject) => { job.readyTimer = setTimeout(() => reject(new Error('Windows codec did not initialize within 15 seconds.')), 15000); })]); clearTimeout(job.readyTimer);
      return {token, ...size, maxChunkBytes: CHUNK, mimeType: 'video/x-msvideo', extension: 'avi'};
    } catch (error) { await this.cancel(token); throw error; }
  }
  beginFrame(token, {index, size} = {}) {
    const job = this._job(token); if (job.frame || index !== job.written || index >= job.totalFrames || size !== job.frameBytes) throw new Error('Windows video frames must be sequential and match the exact RGB24 size.');
    job.frame = {index, remaining: size, ack: deferred()}; return {index, remaining: size};
  }
  async writeFrameChunk(token, bytes) {
    const job = this._job(token), frame = job.frame;
    if (!frame || !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)) || bytes.byteLength < 1 || bytes.byteLength > CHUNK || bytes.byteLength > frame.remaining) throw new Error('Invalid Windows video frame chunk.');
    const data = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); frame.remaining -= data.length;
    await new Promise((resolve, reject) => job.child.stdin.write(data, error => error ? reject(error) : resolve())); this._job(token);
    return {remaining: frame.remaining};
  }
  async endFrame(token) {
    const job = this._job(token), frame = job.frame; if (!frame || frame.remaining !== 0) throw new Error('The Windows video frame is incomplete.');
    const result = await frame.ack.promise; this._job(token); job.frame = null; job.written++;
    if (job.written === job.totalFrames) job.child.stdin.end();
    return {index: frame.index, completed: job.written, bytesWritten: result.bytesWritten};
  }
  async finish(token) {
    const job = this._job(token); if (job.frame || job.written !== job.totalFrames) throw new Error('Complete every Windows video frame before finishing.');
    await job.completion.promise; const stat = await fs.stat(job.outputPath);
    if (stat.size < 256 || stat.size > MAX_OUTPUT) throw new Error('The Windows codec produced an empty or oversized AVI file.');
    job.size = stat.size; job.file ??= await fs.open(job.outputPath, 'r'); clearTimeout(job.timer);
    return {token, size: stat.size, frames: job.written, width: job.width, height: job.height, codecId: job.codecId, mimeType: 'video/x-msvideo', extension: 'avi'};
  }
  async read(token) {
    const job = this._job(token); if (!job.file) throw new Error('Finish the Windows video before reading it.');
    const data = Buffer.alloc(Math.min(CHUNK, job.size - job.read)), result = await job.file.read(data, 0, data.length, job.read); job.read += result.bytesRead;
    return {bytes: new Uint8Array(data.buffer, data.byteOffset, result.bytesRead), done: job.read >= job.size, read: job.read, total: job.size};
  }
  async cancel(token) {
    const job = this.jobs.get(token); if (!job) return {cancelled: false}; this.jobs.delete(token);
    clearTimeout(job.timer); clearTimeout(job.readyTimer); this._fail(job, new Error('Windows video export cancelled.'));
    await job.file?.close();
    if (job.child && job.child.exitCode === null) await new Promise(resolve => { job.child.once('exit', resolve); setTimeout(resolve, 2000).unref(); });
    await fs.rm(job.directory, {recursive: true, force: true}); return {cancelled: true};
  }
  async dispose() {
    this.disposed = true; for (const child of this.commands) child.kill(); this.commands.clear();
    await Promise.allSettled([...this.jobs.keys()].map(token => this.cancel(token)));
    await Promise.allSettled([...this.configurations.values()].map(config => fs.rm(config.directory, {recursive: true, force: true}))); this.configurations.clear(); this.cache.clear();
  }
}
module.exports = {VfwExportService, VFW_LIMITS: {maxChunkBytes: CHUNK, maxFrameBytes: MAX_FRAME, maxBytes: MAX_OUTPUT, maxStateBytes: MAX_STATE}};
