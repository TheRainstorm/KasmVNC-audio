#!/bin/bash
timeout 12 parec --device=vsink.monitor --format=float32le --rate=48000 --channels=2 > /tmp/monitor.f32 2>/tmp/parec.err
echo "parec stderr:"; cat /tmp/parec.err
python3 - <<'PYEOF'
import struct
data = open("/tmp/monitor.f32", "rb").read()
n = len(data) // 4
f = struct.unpack("<%df" % n, data[:n * 4]) if n else []
print("captured floats:", n)
for sec in range(min(10, n // 96000)):
    chunk = f[sec * 96000:(sec + 1) * 96000]
    if not chunk:
        break
    dc = sum(chunk) / len(chunk)
    amps = [abs(x) for x in chunk]
    print("sec", sec, "dc:", round(dc, 5), "max:", round(max(amps), 4), "mean:", round(sum(amps) / len(amps), 4), "uniq:", len(set(chunk[:500])))
PYEOF
