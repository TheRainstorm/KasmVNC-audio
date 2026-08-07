#!/bin/bash
# KasmVNC 音频: vsink.monitor -> (1) WebSocket 低延迟 PCM (2) Icecast MP3 兜底
exec 9>/home/yfy/.vnc/audio-stream.lock
flock -n 9 || exit 0

ICEPASS=$(cat /home/yfy/.vnc/.icecast-source-pass 2>/dev/null)
[ -z "$ICEPASS" ] && ICEPASS=changeme
ICE_URL="icecast://source:${ICEPASS}@127.0.0.1:8445/live.mp3"

while true; do
    if ! pactl info >/dev/null 2>&1 || ! pactl list short sinks 2>/dev/null | grep -q vsink; then
        sleep 3
        continue
    fi
    echo "$(date '+%F %T') starting ffmpeg push" >>/home/yfy/.vnc/audio-stream.log
    ffmpeg -hide_banner -loglevel warning -fflags nobuffer \
        -f pulse -fragment_size 512 -i vsink.monitor \
        -ac 2 -ar 48000 -f f32le \
        tcp://127.0.0.1:8450 \
        >>/home/yfy/.vnc/audio-stream.log 2>&1 &
    FF_PCM=$!
    ffmpeg -hide_banner -loglevel warning \
        -f pulse -i vsink.monitor \
        -c:a libmp3lame -b:a 128k -ar 44100 -ac 2 \
        -content_type audio/mpeg -f mp3 "$ICE_URL" \
        >>/home/yfy/.vnc/audio-stream.log 2>&1 &
    FF_MP3=$!
    wait -n $FF_PCM $FF_MP3
    echo "$(date '+%F %T') one ffmpeg exited, restarting both" >>/home/yfy/.vnc/audio-stream.log
    kill $FF_PCM $FF_MP3 2>/dev/null
    wait $FF_PCM $FF_MP3 2>/dev/null
    sleep 3
done
