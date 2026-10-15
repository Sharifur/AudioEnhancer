// Captures raw mono PCM from the mic and posts ~0.25 s chunks to the page.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 4);
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.on = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.n = 0; }
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (this.n > 0) { this.port.postMessage({ pcm: this.buf.slice(0, this.n) }); this.n = 0; }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]); if (v > (this.peak || 0)) this.peak = v;
      if (this.on) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) this.flush();
      }
    }
    this.frames = (this.frames || 0) + ch.length;
    if (this.frames >= 2048) { this.port.postMessage({ peak: this.peak }); this.peak = 0; this.frames = 0; }
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);
