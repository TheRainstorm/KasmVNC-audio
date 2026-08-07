#!/bin/bash
cap() {
    timeout 3 parec --device=vsink.monitor --format=float32le --rate=48000 --channels=2 > /tmp/monitor.f32 2>/dev/null
    python3 - "$1" <<'PYEOF'
import struct, sys
data = open("/tmp/monitor.f32", "rb").read()
n = len(data) // 4
f = struct.unpack("<%df" % n, data[:n * 4]) if n else []
if not f:
    print(sys.argv[1], "NO DATA")
else:
    dc = sum(f) / len(f)
    print(sys.argv[1], "dc:", round(dc, 5), "uniq:", len(set(f[:500])), "max:", round(max(abs(x) for x in f), 4))
PYEOF
}

cap "baseline"
for id in 3 73 133 140; do
    pactl set-sink-input-mute "$id" 1
    cap "muted#$id"
    pactl set-sink-input-mute "$id" 0
done
