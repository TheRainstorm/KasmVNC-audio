const CDP = 'http://127.0.0.1:9222';
const url = 'http://127.0.0.1:8000/test-audio.html';
(async () => {
  const target = await (await fetch(CDP + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => ws.onopen = r);
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));
  const r = await send('Runtime.evaluate', {
    expression: "JSON.stringify({status: document.getElementById('kasmAudioStatus') ? document.getElementById('kasmAudioStatus').textContent : null, debug: window.__kasmAudioDebug ? window.__kasmAudioDebug() : null, spec: window.__kasmAudioSpectrum ? window.__kasmAudioSpectrum() : null})",
    returnByValue: true
  });
  console.log('RESULT:', JSON.stringify(r.result, null, 2));
  process.exit(0);
})();
