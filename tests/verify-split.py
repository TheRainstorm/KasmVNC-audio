import asyncio, struct, ssl, math, time, websockets

async def main():
    sslc = ssl.create_default_context(); sslc.check_hostname = False; sslc.verify_mode = ssl.CERT_NONE
    async with websockets.connect("wss://127.0.0.1:8444/ws-audio", ssl=sslc, max_size=None) as ws:
        got = b""
        t0 = time.time()
        while time.time() - t0 < 3:
            try:
                got += await asyncio.wait_for(ws.recv(), timeout=1)
            except asyncio.TimeoutError:
                pass
    n = len(got) // 4
    f = struct.unpack("<%df" % n, got[:n * 4])
    N = 48000
    def mag(xs, freq):
        re = 0.0; im = 0.0
        for i in range(N):
            w = xs[i] * (0.5 - 0.5 * math.cos(2 * math.pi * i / N))
            re += w * math.cos(2 * math.pi * freq * i / 48000)
            im += w * math.sin(2 * math.pi * freq * i / 48000)
        return math.hypot(re, im) * 2 / (N * 0.5)
    # OLD split (current player): c0 = f[0:N], c1 = f[N:2N]
    old_c0 = f[:N]
    # NEW split (de-interleave): c0 = f[0::2] -> need N frames
    new_c0 = f[:2 * N:2]
    print("old split c0 mags: 220=%.4f 440=%.4f 880=%.4f" % (mag(old_c0, 220), mag(old_c0, 440), mag(old_c0, 880)))
    print("new split c0 mags: 220=%.4f 440=%.4f 880=%.4f" % (mag(new_c0, 220), mag(new_c0, 440), mag(new_c0, 880)))

asyncio.run(main())
