#!/usr/bin/env python3
"""KasmVNC audio relay v2: FFmpeg PCM (TCP 8450) -> browsers (WS 8451 /ws-audio).
Reads small chunks (512B) and forwards immediately for smooth low-latency delivery."""
import asyncio
import websockets

TCP_HOST, TCP_PORT = "127.0.0.1", 8450
WS_HOST, WS_PORT = "127.0.0.1", 8451
CHUNK = 256
clients = set()


async def tcp_handler(reader, writer):
    try:
        while True:
            data = await reader.read(CHUNK)
            if not data:
                break
            if clients:
                await asyncio.gather(
                    *(c.send(data) for c in tuple(clients)),
                    return_exceptions=True,
                )
    finally:
        writer.close()
        await writer.wait_closed()


async def ws_handler(ws, path=None):
    clients.add(ws)
    try:
        await ws.wait_closed()
    finally:
        clients.discard(ws)


async def main():
    tcp_srv = await asyncio.start_server(tcp_handler, TCP_HOST, TCP_PORT)
    ws_srv = await websockets.serve(ws_handler, WS_HOST, WS_PORT)
    print("audio-relay v2 (chunk=%d): tcp %s:%d ws %s:%d" % (CHUNK, TCP_HOST, TCP_PORT, WS_HOST, WS_PORT), flush=True)
    async with tcp_srv, ws_srv:
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
