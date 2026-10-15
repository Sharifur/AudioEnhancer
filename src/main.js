const { app, BrowserWindow, ipcMain, dialog, shell, session, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { enhance, isMedia } = require('./engine');

// ------------------------------------------------------------ settings ----
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = () => ({
  outDir: path.join(app.getPath('music'), 'Voice Enhancer'),
  denoiseMix: 0.9,
  lufs: -16,
  keepRaw: true,
  makeMp3: true,
  micId: 'default',
});
let settings;
function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS(), ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) }; }
  catch { settings = DEFAULT_SETTINGS(); }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

// ------------------------------------------------------------ ffmpeg ------
function ffmpegWorks(bin) {
  if (!bin || !fs.existsSync(bin)) return false;
  const f = spawnSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  const e = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return f.status === 0 && /arnndn/.test(f.stdout) && /deesser/.test(f.stdout) && /libmp3lame/.test(e.stdout);
}
function resolveFfmpeg() {
  const candidates = [];
  try {
    candidates.push(require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'));
  } catch { /* not installed */ }
  candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  return candidates.find(ffmpegWorks) || null;
}
const MODEL = () => app.isPackaged
  ? path.join(process.resourcesPath, 'voice-denoise.rnnn')
  : path.join(__dirname, '..', 'resources', 'voice-denoise.rnnn');

// ------------------------------------------------------------ window ------
let win;
let FFMPEG;
function createWindow() {
  win = new BrowserWindow({
    width: 820, height: 760, minWidth: 640, minHeight: 600,
    title: 'Voice Enhancer',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#00000000',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  loadSettings();
  FFMPEG = resolveFfmpeg();
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* ignore */ }
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ------------------------------------------------------------ queue -------
let nextId = 1;
const queue = [];
let busy = false;
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

function addJob(file, { source = 'file', removeAfter = false } = {}) {
  const job = { id: nextId++, file, name: path.basename(file), source, removeAfter, status: 'queued', progress: 0 };
  queue.push(job);
  send('job', publicJob(job));
  pump();
  return job.id;
}
function publicJob(j) {
  return {
    id: j.id, name: j.name, source: j.source, status: j.status, progress: j.progress, stage: j.stage,
    error: j.error, note: j.note, lufs: j.lufs,
    original: j.removeAfter ? null : pathToFileURL(j.file).href,
    enhanced: j.wav ? pathToFileURL(j.wav).href : null,
    enhancedPath: j.wav || null,
  };
}
async function pump() {
  if (busy) return;
  const job = queue.find(j => j.status === 'queued');
  if (!job) return;
  busy = true;
  job.status = 'working';
  send('job', publicJob(job));
  try {
    if (!FFMPEG) throw new Error('ffmpeg not found. Run "npm install" again, or "brew install ffmpeg".');
    let lastSent = 0;
    const r = await enhance(job.file, {
      ffmpeg: FFMPEG, modelPath: MODEL(), outDir: settings.outDir,
      denoiseMix: settings.denoiseMix, lufs: settings.lufs, makeMp3: settings.makeMp3,
      onProgress: (p, stage) => {
        job.progress = p; job.stage = stage;
        const now = Date.now();
        if (now - lastSent > 120 || p >= 1) { lastSent = now; send('job', publicJob(job)); }
      },
    });
    if (r.skipped) { job.status = 'skipped'; job.note = r.skipped; }
    else { job.status = 'done'; job.wav = r.wav; job.lufs = r.lufs; }
  } catch (e) {
    job.status = 'error'; job.error = e.message;
  }
  if (job.removeAfter && job.status === 'done') fs.rm(job.file, { force: true }, () => {});
  send('job', publicJob(job));
  busy = false;
  pump();
}

// ------------------------------------------------------------ recording ---
// Renderer streams Float32 mono PCM chunks; we write a 24-bit WAV on disk so
// long recordings never sit in memory.
let rec = null;
function wavHeader(dataBytes, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 3, 28); h.writeUInt16LE(3, 32); h.writeUInt16LE(24, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}
function stamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

ipcMain.handle('rec:start', (_e, { sampleRate }) => {
  const dir = settings.keepRaw ? path.join(settings.outDir, 'Raw recordings') : fs.mkdtempSync(path.join(os.tmpdir(), 'voicerec-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `Recording ${stamp()}.wav`);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, wavHeader(0, sampleRate));
  rec = { fd, file, bytes: 0, sampleRate };
  return { file };
});
ipcMain.on('rec:chunk', (_e, ab) => {
  if (!rec) return;
  const f = new Float32Array(ab);
  const out = Buffer.alloc(f.length * 3);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out.writeIntLE(Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff), i * 3, 3);
  }
  fs.writeSync(rec.fd, out);
  rec.bytes += out.length;
});
ipcMain.handle('rec:stop', (_e, { discard } = {}) => {
  if (!rec) return null;
  const { fd, file, bytes, sampleRate } = rec; rec = null;
  fs.writeSync(fd, wavHeader(bytes, sampleRate), 0, 44, 0);
  fs.closeSync(fd);
  if (discard || bytes < sampleRate * 3 * 0.3) { fs.rmSync(file, { force: true }); return null; } // < 0.3 s
  return addJob(file, { source: 'recording', removeAfter: !settings.keepRaw });
});

// ------------------------------------------------------------ other IPC ---
ipcMain.handle('settings:get', () => ({ ...settings, ffmpegOk: !!FFMPEG, home: os.homedir() }));
ipcMain.handle('settings:set', (_e, patch) => { Object.assign(settings, patch); saveSettings(); return settings; });
ipcMain.handle('folder:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Save enhanced audio to…', defaultPath: settings.outDir,
    properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return settings.outDir;
  settings.outDir = r.filePaths[0]; saveSettings(); return settings.outDir;
});
ipcMain.handle('folder:open', () => { fs.mkdirSync(settings.outDir, { recursive: true }); return shell.openPath(settings.outDir); });
ipcMain.handle('files:choose', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio & video', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'caf', 'mp4', 'mov', 'mkv', 'webm'] }] });
  if (!r.canceled) r.filePaths.forEach(f => addJob(f));
});
ipcMain.handle('files:add', (_e, paths) => {
  const files = [];
  for (const p of paths) {
    try {
      if (fs.statSync(p).isDirectory()) {
        fs.readdirSync(p).sort().filter(n => !n.startsWith('.')).map(n => path.join(p, n))
          .filter(f => fs.statSync(f).isFile() && isMedia(f)).forEach(f => files.push(f));
      } else if (isMedia(p)) files.push(p);
    } catch { /* ignore */ }
  }
  files.forEach(f => addJob(f));
  return files.length;
});
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));
