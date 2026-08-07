import asyncio, socket, struct, ssl, math, time, websockets

def grab_tcp(host, port, seconds):
    s = socket.create_connection((host, port), timeout=3)
    s.settimeout(1)
    got = b""
    t0 = time.time()
    while time.time() - t0 < seconds:
        try:
            d = s.recv(65536)
            if not d:
                break
            got += d
        except socket.timeout:
            pass
    s.close()
    return got

def analyze(tag, got):
    n = len(got) // 4
    if n == 0:
        print(tag, "NO DATA"); return
    f = struct.unpack("<%df" % n, got[:n * 4])
    amps = [abs(x) for x in f]
    print(tag, "bytes:", len(got), "floats:", n, "max:", round(max(amps), 4),
          "mean:", round(sum(amps) / len(amps), 4), "uniq(first 1000):", len(set(f[:1000])))
    print(tag, "first bytes:", got[:16].hex())

async def grab_ws(ws_url, seconds, sslc=None):
    async with websockets.connect(ws_url, ssl=sslc, max_size=None) as ws:
        got = b""
        t0 = time.time()
        while time.time() - t0 < seconds:
            try:
                got += await asyncio.wait_for(ws.recv(), timeout=1)
            except asyncio.TimeoutError:
                pass
        return got

async def main():
    analyze("TCP8450 ", grab_tcp("127.0.0.1", 8450, 2))
    analyze("WS8451  ", await grab_ws("ws://127.0.0.1:8451/ws-audio", 2))
    sslc = ssl.create_default_context(); sslc.check_hostname = False; sslc.verify_mode = ssl.CERT_NONE
    analyze("WSS8444 ", await grab_ws("wss://127.0.0.1:8444/ws-audio", 2, sslc))

asyncio.run(main())
