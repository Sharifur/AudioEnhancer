const $ = (id) => document.getElementById(id);
let S = {};

// ------------------------------------------------------------ settings ----
async function init() {
  S = await window.api.getSettings();
  showFolder(S.outDir);
  $('ffmpegWarn').hidden = S.ffmpegOk;
  $('denoise').value = S.denoiseMix; $('denoiseVal').textContent = Math.round(S.denoiseMix * 100) + '%';
  $('lufs').value = String(S.lufs);
  $('keepRaw').checked = S.keepRaw;
  $('makeMp3').checked = S.makeMp3;
  await listMics(true);
}
function showFolder(p) {
  $('outPath').textContent = S.home && p.startsWith(S.home) ? '~' + p.slice(S.home.length) : p;
  $('outPath').title = p;
}
$('changeFolder').onclick = async () => { S.outDir = await window.api.chooseFolder(); showFolder(S.outDir); };
$('openFolder').onclick = () => window.api.openFolder();
$('denoise').oninput = (e) => { $('denoiseVal').textContent = Math.round(e.target.value * 100) + '%'; };
$('denoise').onchange = (e) => window.api.setSettings({ denoiseMix: parseFloat(e.target.value) });
$('lufs').onchange = (e) => window.api.setSettings({ lufs: parseFloat(e.target.value) });
$('keepRaw').onchange = (e) => window.api.setSettings({ keepRaw: e.target.checked });
$('makeMp3').onchange = (e) => window.api.setSettings({ makeMp3: e.target.checked });

// ------------------------------------------------------------ mics --------
async function listMics(askLabels) {
  try {
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (askLabels && devs.some(d => d.kind === 'audioinput' && !d.label)) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    }
    const mics = devs.filter(d => d.kind === 'audioinput');
    const sel = $('micSelect');
    sel.innerHTML = '';
    for (const m of mics) {
      const o = document.createElement('option');
      o.value = m.deviceId; o.textContent = m.label || (m.deviceId === 'default' ? 'Default microphone' : 'Microphone');
      sel.appendChild(o);
    }
    if (!mics.length) sel.innerHTML = '<option>No microphone found</option>';
    if (mics.some(m => m.deviceId === S.micId)) sel.value = S.micId;
  } catch {
    $('micSelect').innerHTML = '<option>Microphone access denied (System Settings › Privacy › Microphone)</option>';
  }
}
$('micSelect').onchange = (e) => { S.micId = e.target.value; window.api.setSettings({ micId: S.micId }); };
navigator.mediaDevices.addEventListener('devicechange', () => listMics(false));

// ------------------------------------------------------------ recorder ----
let R = null; // { stream, ctx, node, t0, timer }
async function startRec() {
  if (R) return;
  const deviceId = $('micSelect').value;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        channelCount: 1, sampleRate: 48000,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false, // raw signal; we clean it later
      },
    });
  } catch (e) {
    alertBox('Could not open the microphone. Allow access in System Settings › Privacy & Security › Microphone.');
    return;
  }
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('recorder-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  await window.api.recStart(ctx.sampleRate);

  let done;
  const finished = new Promise(r => { done = r; });
  node.port.onmessage = (e) => {
    const d = e.data;
    if (d.pcm) window.api.recChunk(d.pcm);
    if (d.peak !== undefined) setMeter(d.peak);
    if (d.done) done();
  };
  node.port.postMessage('start');

  R = { stream, ctx, node, finished, t0: performance.now() };
  R.timer = setInterval(() => { $('timer').textContent = fmt((performance.now() - R.t0) / 1000); }, 200);
  document.body.classList.add('recording');
  $('recBtn').classList.add('on'); $('recBtn').setAttribute('aria-label', 'Stop recording');
  $('recTitle').textContent = 'Recording…  click to stop';
  $('discardBtn').hidden = false;
  $('micSelect').disabled = true;
}
async function stopRec(discard = false) {
  if (!R) return;
  const r = R; R = null;
  r.node.port.postMessage('stop');
  await Promise.race([r.finished, new Promise(res => setTimeout(res, 1000))]);
  clearInterval(r.timer);
  r.stream.getTracks().forEach(t => t.stop());
  r.ctx.close();
  await window.api.recStop(discard, $('recName').value.trim());
  $('recName').value = '';
  document.body.classList.remove('recording');
  $('recBtn').classList.remove('on'); $('recBtn').setAttribute('aria-label', 'Start recording');
  $('recTitle').textContent = discard ? 'Recording discarded' : 'Saved. Enhancing…';
  setTimeout(() => { if (!R) $('recTitle').textContent = 'Record your voice'; }, 2500);
  $('timer').textContent = '00:00';
  $('discardBtn').hidden = true;
  $('micSelect').disabled = false;
  setMeter(0);
}
$('recBtn').onclick = () => (R ? stopRec() : startRec());
$('discardBtn').onclick = () => stopRec(true);
$('recName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); R ? stopRec() : startRec(); }
});
function setMeter(peak) {
  const db = peak > 0 ? 20 * Math.log10(peak) : -90;
  $('meter').style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
}
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// ------------------------------------------------------------ drop --------
const drop = $('drop');
drop.onclick = () => window.api.chooseFiles();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.api.chooseFiles(); } };
window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files.length) {
    const n = await window.api.addFiles(e.dataTransfer.files);
    if (!n) alertBox('No audio or video files found in what you dropped.');
  }
});

// ------------------------------------------------------------ jobs --------
const jobs = new Map();
const ICON_FILE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>';
const ICON_MIC = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>';

window.api.onJob((j) => {
  $('empty').hidden = true;
  let el = jobs.get(j.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'job card';
    el.innerHTML = `
      <div class="job-head">
        <div class="job-icon ${j.source === 'recording' ? 'rec' : ''}">${j.source === 'recording' ? ICON_MIC : ICON_FILE}</div>
        <div class="job-name"></div>
        <div class="job-status"></div>
      </div>
      <div class="bar"><div></div></div>`;
    el.querySelector('.job-name').textContent = j.name;
    $('jobs').prepend(el);
    jobs.set(j.id, el);
  }
  const st = el.querySelector('.job-status');
  const bar = el.querySelector('.bar');
  st.className = 'job-status';
  if (j.status === 'queued') st.textContent = 'Waiting…';
  if (j.status === 'working') { st.textContent = `${j.stage || 'Starting'} · ${Math.round(j.progress * 100)}%`; bar.firstElementChild.style.width = (j.progress * 100) + '%'; }
  if (j.status === 'skipped') { st.textContent = `Skipped: ${j.note}`; bar.remove(); }
  if (j.status === 'error') { st.classList.add('error'); st.textContent = j.error; bar.remove(); }
  if (j.status === 'done' && !el.querySelector('.player')) {
    st.classList.add('done');
    st.textContent = `Enhanced · ${j.lufs != null ? j.lufs.toFixed(1) + ' LUFS' : ''}`;
    bar.remove();
    el.appendChild(makePlayer(j));
  }
});

let current = null; // the player currently playing
function makePlayer(j) {
  const wrap = document.createElement('div');
  wrap.className = 'player';
  wrap.innerHTML = `
    <button class="play" aria-label="Play">${PLAY}</button>
    <div class="seg">${j.original ? '<button data-m="orig">Before</button>' : ''}<button data-m="enh" class="on">After</button></div>
    <input class="scrub" type="range" min="0" max="1000" value="0" aria-label="Position">
    <span class="time">00:00</span>
    <button class="btn ghost small reveal">Show in Finder</button>`;
  const a = { enh: new Audio(j.enhanced), orig: j.original ? new Audio(j.original) : null };
  let mode = 'enh';
  const active = () => a[mode];
  const btn = wrap.querySelector('.play');
  const scrub = wrap.querySelector('.scrub');
  const time = wrap.querySelector('.time');
  const self = {
    pause() { Object.values(a).forEach(x => x && x.pause()); btn.innerHTML = PLAY; },
  };
  btn.onclick = () => {
    if (active().paused) {
      if (current && current !== self) current.pause();
      current = self; active().play(); btn.innerHTML = PAUSE;
    } else self.pause();
  };
  wrap.querySelectorAll('.seg button').forEach(b => {
    b.onclick = () => {
      if (b.dataset.m === mode) return;
      const playing = !active().paused; const t = active().currentTime;
      active().pause();
      mode = b.dataset.m;
      active().currentTime = t;
      if (playing) active().play();
      wrap.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    };
  });
  for (const k of ['enh', 'orig']) {
    if (!a[k]) continue;
    a[k].ontimeupdate = () => {
      if (k !== mode) return;
      const d = a[k].duration || 0;
      scrub.value = d ? (a[k].currentTime / d) * 1000 : 0;
      time.textContent = fmt(a[k].currentTime) + ' / ' + fmt(d);
    };
    a[k].onended = () => { btn.innerHTML = PLAY; };
    a[k].onloadedmetadata = () => { if (k === mode) time.textContent = '00:00 / ' + fmt(a[k].duration); };
  }
  scrub.oninput = () => { const d = active().duration || 0; active().currentTime = (scrub.value / 1000) * d; };
  wrap.querySelector('.reveal').onclick = () => window.api.reveal(j.enhancedPath);
  return wrap;
}

function alertBox(msg) {
  const d = document.createElement('div');
  d.className = 'warn'; d.textContent = msg;
  document.querySelector('main').prepend(d);
  setTimeout(() => d.remove(), 6000);
}

init();
