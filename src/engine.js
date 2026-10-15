// Voice Enhancer engine: the exact same processing chain as enhance.sh.
// Pure Node (no Electron imports) so it can be tested on its own.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  lufs: -16,        // loudness target (YouTube / podcast)
  truePeak: -1.5,   // dBTP ceiling
  lra: 7,
  denoiseMix: 0.9,  // AI noise removal strength 0..1
  sampleRate: 48000,
  mp3Bitrate: '320k',
  makeMp3: true,
};

const MEDIA_EXT = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus',
  'aif', 'aiff', 'caf', 'mp4', 'mov', 'mkv', 'webm']);

function isMedia(file) {
  return MEDIA_EXT.has(path.extname(file).slice(1).toLowerCase());
}

// ffmpeg filter args break on spaces/colons in paths, so keep the model at a clean temp path.
function prepareModel(modelSrc) {
  const dst = path.join(os.tmpdir(), 'voice-enhancer-model.rnnn');
  const srcStat = fs.statSync(modelSrc);
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== srcStat.size) fs.copyFileSync(modelSrc, dst);
  if (/[\s:,'\\]/.test(dst)) throw new Error(`Temp path not usable by ffmpeg: ${dst}`);
  return dst;
}

function buildChain(modelPath, denoiseMix) {
  return [
    'highpass=f=80:poles=2',                                   // rumble
    `arnndn=m=${modelPath}:mix=${denoiseMix}`,                 // AI denoise
    'afftdn=nr=8:nf=-50:tn=1',                                 // residual hiss
    'equalizer=f=250:t=q:w=1.2:g=-2.5',                        // de-mud
    'equalizer=f=3200:t=q:w=1.0:g=2.5',                        // presence
    'highshelf=f=9000:g=2',                                    // air
    'lowshelf=f=140:g=1.5',                                    // warmth
    'deesser=i=0.4:m=0.5:f=0.5',                               // sibilance
    'acompressor=threshold=-22dB:ratio=3:attack=5:release=90:makeup=3dB:knee=4',
    'agate=threshold=0.008:ratio=2:range=0.25:attack=5:release=200',
    'alimiter=limit=0.89:attack=3:release=50',
  ].join(',');
}

function run(ffmpeg, args, { onProgress, duration } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-nostdin', '-hide_banner', ...args]);
    let stderr = '';
    let buf = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.stdout.on('data', d => {
      if (!onProgress || !duration) return;
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        const m = l.match(/^out_time_us=(\d+)/);
        if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(stderr)
      : reject(new Error(stderr.split('\n').filter(Boolean).slice(-3).join(' | ') || `ffmpeg exited ${code}`)));
  });
}

async function probeDuration(ffmpeg, file) {
  const err = await run(ffmpeg, ['-i', file, '-map', '0:a:0', '-f', 'null', '-t', '0', '-']).catch(e => String(e));
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}

async function audioMd5(ffmpeg, file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-f', 'md5', '-']);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  });
}

// Dual-channel recorders write *.L.L.wav and *.L.R.wav. Returns the L twin path if `file` is an R copy.
function twinOf(file) {
  const t = file.replace(/\.L\.R\.(\w+)$/, '.L.L.$1').replace(/_R\.wav$/i, '_L.wav').replace(/\.R\.wav$/i, '.L.wav');
  return t !== file && fs.existsSync(t) ? t : null;
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; ; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
}

/**
 * Enhance one file.
 * @returns {Promise<{skipped?:string, wav?:string, mp3?:string, lufs?:number}>}
 */
async function enhance(input, opts) {
  const o = { ...DEFAULTS, ...opts };
  const { ffmpeg, modelPath, outDir, onProgress = () => {}, overwrite = false } = o;
  if (!ffmpeg) throw new Error('ffmpeg not found');
  fs.mkdirSync(outDir, { recursive: true });

  const twin = twinOf(input);
  if (twin && (await audioMd5(ffmpeg, input)) === (await audioMd5(ffmpeg, twin))) {
    return { skipped: `identical to ${path.basename(twin)}` };
  }

  const base = path.parse(input).name;
  let outWav = path.join(outDir, `${base}_pro.wav`);
  if (!overwrite) outWav = uniquePath(outWav);
  const outMp3 = outWav.replace(/\.wav$/, '.mp3');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceenh-'));
  const stage = path.join(work, 'stage.wav');

  try {
    const duration = await probeDuration(ffmpeg, input);
    const model = prepareModel(modelPath);

    // Pass 1: voice chain (0 - 70%)
    await run(ffmpeg, ['-v', 'error', '-y', '-progress', 'pipe:1', '-nostats', '-i', input,
      '-map', '0:a:0', '-ac', '1', '-af', buildChain(model, o.denoiseMix),
      '-ar', String(o.sampleRate), '-c:a', 'pcm_s24le', stage],
      { duration, onProgress: f => onProgress(f * 0.7, 'Cleaning voice') });

    // Pass 2: measure loudness (70 - 80%)
    onProgress(0.72, 'Measuring loudness');
    const ln = `loudnorm=I=${o.lufs}:TP=${o.truePeak}:LRA=${o.lra}`;
    const err = await run(ffmpeg, ['-i', stage, '-af', `${ln}:print_format=json`, '-f', 'null', '-']);
    const j = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
    const measured = parseFloat(j.input_i);
    if (!Number.isFinite(measured) || measured < -60) {
      throw new Error('No voice detected in this audio. Check that the right microphone is selected.');
    }

    // Pass 3: exact loudness (80 - 95%)
    await run(ffmpeg, ['-v', 'error', '-y', '-progress', 'pipe:1', '-nostats', '-i', stage, '-af',
      `${ln}:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}` +
      `:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`,
      '-ar', String(o.sampleRate), '-c:a', 'pcm_s24le', outWav],
      { duration, onProgress: f => onProgress(0.8 + f * 0.15, 'Leveling loudness') });

    if (o.makeMp3) {
      onProgress(0.96, 'Saving MP3');
      await run(ffmpeg, ['-v', 'error', '-y', '-i', outWav, '-c:a', 'libmp3lame', '-b:a', o.mp3Bitrate, outMp3]);
    }

    const meas = await run(ffmpeg, ['-i', outWav, '-af', 'ebur128', '-f', 'null', '-']);
    const im = [...meas.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
    onProgress(1, 'Done');
    return { wav: outWav, mp3: o.makeMp3 ? outMp3 : null, lufs: im ? parseFloat(im[1]) : null };
  } catch (e) {
    for (const f of [outWav, outMp3]) fs.rmSync(f, { force: true }); // no half-written outputs
    throw e;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { enhance, isMedia, buildChain, DEFAULTS };
