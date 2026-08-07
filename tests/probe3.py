import asyncio, struct, ssl, math, websockets

async def main():
    sslc = ssl.create_default_context()
    sslc.check_hostname = False
    sslc.verify_mode = ssl.CERT_NONE
    async with websockets.connect("wss://127.0.0.1:8444/ws-audio", ssl=sslc, max_size=None) as ws:
        got = b""
        t0 = __import__("time").time()
        while __import__("time").time() - t0 < 3:
            try:
                got += await asyncio.wait_for(ws.recv(), timeout=1)
            except asyncio.TimeoutError:
                pass
        print("total bytes:", len(got))
        n = len(got) // 4
        f = struct.unpack("<%df" % n, got[:n * 4])
        amps = [abs(x) for x in f]
        print("floats:", n, "max:", max(amps), "mean:", sum(amps) / len(amps))
        # DC component and correlation of L/R
        L = f[0::2]; R = f[1::2]
        dc = sum(f) / len(f)
        lr = sum(a * b for a, b in zip(L, R)) / math.sqrt(sum(a * a for a in L) * sum(b * b for b in R) + 1e-9)
        print("DC mean:", round(dc, 6), "L/R corr:", round(lr, 4))
        # DFT magnitude at 880Hz over first 48000 samples vs total energy
        N = min(48000, len(f))
        xs = f[:N]
        hann = [0.5 - 0.5 * math.cos(2 * math.pi * i / N) for i in range(N)]
        def dft_mag(freq):
            re = 0.0; im = 0.0
            for i in range(N):
                w = xs[i] * hann[i]
                re += w * math.cos(2 * math.pi * freq * i / 48000)
                im += w * math.sin(2 * math.pi * freq * i / 48000)
            return math.hypot(re, im) * 2 / (N * 0.5)
        total = math.sqrt(sum((x * h) ** 2 for x, h in zip(xs, hann)) / N)
        for fr in (880, 440, 1760, 60):
            print("freq", fr, "mag:", round(dft_mag(fr), 4))
        print("hann rms:", round(total, 4))

asyncio.run(main())
