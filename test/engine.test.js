// node test/engine.test.js <inputDir> <outDir>
const path = require('path');
const fs = require('fs');
const { enhance, isMedia } = require('../src/engine');

(async () => {
  const [inDir, outDir] = process.argv.slice(2);
  const files = fs.readdirSync(inDir).filter(isMedia).sort().map(f => path.join(inDir, f));
  for (const f of files) {
    let last = -1;
    const r = await enhance(f, {
      ffmpeg: process.env.FFMPEG || 'ffmpeg',
      modelPath: path.join(__dirname, '..', 'resources', 'voice-denoise.rnnn'),
      outDir,
      onProgress: (p) => { const s = Math.floor(p * 4); if (s !== last) { last = s; process.stdout.write(`${Math.round(p * 100)}% `); } },
    });
    console.log('\n', path.basename(f), JSON.stringify(r));
  }
})().catch(e => { console.error(e); process.exit(1); });
