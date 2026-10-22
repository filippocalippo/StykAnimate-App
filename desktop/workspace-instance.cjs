'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Secondary windows own recovery and Chromium session files. Reuse an inactive
// process's directory so recovery remains discoverable after a crash/restart.
function workspaceDirectory(profile, {pid = process.pid, alive = processAlive} = {}) {
  const root = path.join(profile, 'workspaces'), directory = path.join(root, String(pid));
  fs.mkdirSync(root, {recursive:true});
  if (fs.existsSync(directory)) return directory;
  for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name) || alive(Number(entry.name))) continue;
    try { fs.renameSync(path.join(root, entry.name), directory); return directory; }
    catch (error) { if (!['ENOENT', 'EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) throw error; }
  }
  fs.mkdirSync(directory, {recursive:true}); return directory;
}
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }

// macOS decides which process is the profile's primary workspace without Electron's single-instance
// lock: there, once requestSingleInstanceLock() fails, `ready` never fires, so a secondary window
// (New Window) would never open. The primary holds an exclusive flock(2) on a file in the profile,
// taken atomically by open(O_EXLOCK). The kernel drops it when the process ends in any way, so a crash
// leaves no stale claim and a reused pid cannot inherit it; libuv opens files close-on-exec, so the
// codec and other children never hold it either. Returns the descriptor to keep open, or null.
const O_EXLOCK = 0x20; // <sys/fcntl.h> on macOS; Node does not export it.
function claimPrimaryWorkspace(profile) {
  fs.mkdirSync(profile, {recursive:true});
  const {O_RDONLY, O_CREAT, O_NONBLOCK} = fs.constants;
  try { return fs.openSync(path.join(profile, 'primary-workspace.lock'), O_RDONLY | O_CREAT | O_NONBLOCK | O_EXLOCK); }
  catch (error) { if (error.code === 'EAGAIN') return null; throw error; }
}
module.exports = {workspaceDirectory, claimPrimaryWorkspace};
