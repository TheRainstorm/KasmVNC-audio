import asyncio, struct, subprocess, time, websockets

async def main():
    async with websockets.connect("ws://127.0.0.1:8451/ws-audio", max_size=None) as ws:
        t0 = time.time()
        proc = subprocess.Popen(["/usr/bin/paplay", "/tmp/tone440.wav"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        spawned = time.time()
        print("spawn at %.3f (t0=%.3f)" % (spawned - t0, t0))
        detected = None
        got = b""
        while time.time() - t0 < 6:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=0.2)
                got += msg
                if detected is None and len(got) >= 8192:
                    n = len(got) // 4
                    f = struct.unpack("<%df" % n, got[:n * 4])
                    rms = (sum(x * x for x in f) / n) ** 0.5
                    if rms > 0.005:
                        detected = time.time()
                        print("first non-silent at +%.3f s (rms=%.4f)" % (detected - t0, rms))
                        break
            except asyncio.TimeoutError:
                pass
        if detected is None:
            print("no signal detected")
        else:
            print("SOURCE-SIDE latency: %.0f ms" % ((detected - spawned) * 1000))

asyncio.run(main())
