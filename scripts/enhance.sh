#!/usr/bin/env bash
# ============================================================================
#  Voice Enhancer  |  Same professional voiceover chain, every time.
#
#  Usage:
#    ./enhance.sh                      # processes everything in ./input -> ./output
#    ./enhance.sh file1.wav file2.m4a  # specific files
#    ./enhance.sh /path/to/folder      # every audio/video file in a folder
#    ./enhance.sh -o /out/dir  ...     # custom output folder
#
#  Output per file:  <name>_pro.wav (48 kHz, 24-bit)  +  <name>_pro.mp3 (320k)
#  Target:           -16 LUFS integrated, -1.5 dBTP peak (YouTube / podcast)
#
#  Requires: ffmpeg  (Mac: brew install ffmpeg)
# ============================================================================
set -u

# ---------------------------------------------------------------- settings --
# Change these only if you want a different "house sound". Keep them fixed to
# get identical results every run.
TARGET_LUFS=-16      # loudness (YouTube/podcast standard)
TARGET_TP=-1.5       # true-peak ceiling (dBTP)
TARGET_LRA=7         # loudness range
DENOISE_MIX=0.9      # 0..1  AI noise removal strength (lower = more natural)
MP3_BITRATE=320k
SAMPLE_RATE=48000

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_SRC="$SCRIPT_DIR/models/voice-denoise.rnnn"
# Inside the app repo the model lives in ../resources
[ -f "$MODEL_SRC" ] || MODEL_SRC="$SCRIPT_DIR/../resources/voice-denoise.rnnn"
OUT_DIR="$SCRIPT_DIR/output"

# ------------------------------------------------------------------ checks --
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is not installed."
  echo "On Mac run:   brew install ffmpeg"
  echo "(No Homebrew? Install it first from https://brew.sh)"
  exit 1
fi
if [ ! -f "$MODEL_SRC" ]; then
  echo "Missing noise model: $MODEL_SRC"
  exit 1
fi

# ---------------------------------------------------------------- args ------
INPUTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) INPUTS+=("$1"); shift ;;
  esac
done
[ ${#INPUTS[@]} -eq 0 ] && INPUTS=("$SCRIPT_DIR/input")
mkdir -p "$OUT_DIR"

# ffmpeg filter args can't contain spaces/colons safely, so copy the model
# to a clean temp path.
WORK="$(mktemp -d /tmp/voiceenh.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
cp "$MODEL_SRC" "$WORK/model.rnnn"

# ------------------------------------------------------- the voice chain ----
#  1. High-pass 80 Hz        remove rumble / handling noise
#  2. RNNoise (AI)           remove hiss, fan, room noise
#  3. FFT denoise (light)    clean residual broadband hiss
#  4. EQ  -2.5 dB @ 250 Hz   remove boxy / muddy tone
#         +2.5 dB @ 3.2 kHz  presence & clarity
#         +2 dB shelf 9 kHz  air
#         +1.5 dB shelf 140 Hz  warmth
#  5. De-esser               tame harsh "s" sounds
#  6. Compressor 3:1         even out loud/soft words
#  7. Gentle gate            keep pauses clean
#  8. Limiter                catch peaks
#  9. 2-pass loudnorm        exact -16 LUFS every time
CHAIN="highpass=f=80:poles=2,\
arnndn=m=$WORK/model.rnnn:mix=$DENOISE_MIX,\
afftdn=nr=8:nf=-50:tn=1,\
equalizer=f=250:t=q:w=1.2:g=-2.5,\
equalizer=f=3200:t=q:w=1.0:g=2.5,\
highshelf=f=9000:g=2,\
lowshelf=f=140:g=1.5,\
deesser=i=0.4:m=0.5:f=0.5,\
acompressor=threshold=-22dB:ratio=3:attack=5:release=90:makeup=3dB:knee=4,\
agate=threshold=0.008:ratio=2:range=0.25:attack=5:release=200,\
alimiter=limit=0.89:attack=3:release=50"

audio_md5() { ffmpeg -nostdin -v error -i "$1" -map 0:a:0 -ac 1 -f md5 - 2>/dev/null; }

is_media() {
  case "$(echo "${1##*.}" | tr '[:upper:]' '[:lower:]')" in
    wav|mp3|m4a|aac|flac|ogg|aif|aiff|mp4|mov|mkv|webm) return 0 ;;
    *) return 1 ;;
  esac
}

json_val() { # $1=json text  $2=key
  echo "$1" | awk -v k="\"$2\"" -F'"' '$0 ~ k {print $4; exit}'
}

process() {
  local src="$1"
  local base; base="$(basename "$src")"; base="${base%.*}"
  local out_wav="$OUT_DIR/${base}_pro.wav"
  local out_mp3="$OUT_DIR/${base}_pro.mp3"

  # Dual-channel recorders (e.g. *.L.L.wav / *.L.R.wav) often write two
  # identical files. Skip the R copy if it matches its L twin.
  case "$src" in
    *.L.R.*|*_R.wav|*.R.wav)
      local twin
      twin="$(echo "$src" | sed -E 's/\.L\.R\./.L.L./; s/_R\.wav$/_L.wav/; s/\.R\.wav$/.L.wav/')"
      if [ "$twin" != "$src" ] && [ -f "$twin" ] && [ "$(audio_md5 "$src")" = "$(audio_md5 "$twin")" ]; then
        echo "  skip  $(basename "$src")  (identical to $(basename "$twin"))"
        return 0
      fi ;;
  esac

  echo "  ...   $(basename "$src")"
  local tmp="$WORK/stage.wav"

  # Pass 1: voice chain (mono)
  if ! ffmpeg -nostdin -v error -y -i "$src" -map 0:a:0 -ac 1 -af "$CHAIN" \
        -ar $SAMPLE_RATE -c:a pcm_s24le "$tmp"; then
    echo "  FAIL  $(basename "$src") (chain)"; return 1
  fi

  # Pass 2: measure loudness
  local J
  J="$(ffmpeg -nostdin -hide_banner -i "$tmp" \
        -af loudnorm=I=$TARGET_LUFS:TP=$TARGET_TP:LRA=$TARGET_LRA:print_format=json \
        -f null - 2>&1 | sed -n '/{/,/}/p')"
  local mI mTP mLRA mTH off
  mI=$(json_val "$J" input_i); mTP=$(json_val "$J" input_tp)
  mLRA=$(json_val "$J" input_lra); mTH=$(json_val "$J" input_thresh)
  off=$(json_val "$J" target_offset)

  # Pass 3: exact loudness normalisation
  if ! ffmpeg -nostdin -v error -y -i "$tmp" -af \
      "loudnorm=I=$TARGET_LUFS:TP=$TARGET_TP:LRA=$TARGET_LRA:measured_I=$mI:measured_TP=$mTP:measured_LRA=$mLRA:measured_thresh=$mTH:offset=$off:linear=true" \
      -ar $SAMPLE_RATE -c:a pcm_s24le "$out_wav"; then
    echo "  FAIL  $(basename "$src") (loudness)"; return 1
  fi
  ffmpeg -nostdin -v error -y -i "$out_wav" -c:a libmp3lame -b:a $MP3_BITRATE "$out_mp3"

  local final
  final=$(ffmpeg -nostdin -hide_banner -i "$out_wav" -af ebur128 -f null - 2>&1 | awk '/I:/ {v=$2} END {print v}')
  echo "  done  ${base}_pro.wav / .mp3   (${final} LUFS)"
}

# ---------------------------------------------------------------- run -------
echo "Voice Enhancer  ->  $OUT_DIR"
COUNT=0
for item in "${INPUTS[@]}"; do
  if [ -d "$item" ]; then
    while IFS= read -r f; do
      is_media "$f" && { process "$f"; COUNT=$((COUNT+1)); }
    done < <(find "$item" -maxdepth 1 -type f ! -name '.*' | sort)
  elif [ -f "$item" ]; then
    process "$item"; COUNT=$((COUNT+1))
  else
    echo "  not found: $item"
  fi
done
[ $COUNT -eq 0 ] && echo "No audio files found. Drop files into: $SCRIPT_DIR/input"
echo "Finished."
