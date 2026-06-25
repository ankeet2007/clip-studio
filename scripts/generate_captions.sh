#!/bin/bash
INPUT="$1"
OUTPUT_SRT="$2"
WHISPER="$HOME/whisper.cpp/build/bin/whisper-cli"
MODEL="$HOME/whisper.cpp/models/ggml-small.en.bin"
TMP_WAV="/data/data/com.termux/files/home/myapp/clips_output/tmp_audio_$$.wav"
TMP_BASE="/data/data/com.termux/files/home/myapp/clips_output/tmp_srt_$$"

ffmpeg -y -i "$INPUT" -ar 16000 -ac 1 -c:a pcm_s16le "$TMP_WAV" 2>/dev/null
"$WHISPER" -m "$MODEL" -f "$TMP_WAV" -osrt -of "$TMP_BASE" -t 2 2>/dev/null
rm -f "$TMP_WAV"

if [ ! -f "${TMP_BASE}.srt" ]; then echo "FAIL"; exit 1; fi

python3 "$HOME/myapp/scripts/filter_srt.py" "${TMP_BASE}.srt" "$OUTPUT_SRT"
rm -f "${TMP_BASE}.srt"

[ -f "$OUTPUT_SRT" ] && echo "OK" || echo "FAIL"
