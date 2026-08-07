const CDP = 'http://127.0.0.1:9222';
const url = 'http://127.0.0.1:8000/test-audio.html';
const { spawn } = require('child_process');
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
  for (let i = 0; i < 50; i++) {
    const r = await send('Runtime.evaluate', { expression: "window.__kasmAudioLevel ? (window.__kasmAudioLevel() !== null) : false", returnByValue: true });
    if (r.result.value === true) break;
    await new Promise(r2 => setTimeout(r2, 200));
  }
  const t0 = Date.now();
  console.log('POLLING t0=' + t0);
  let last = -999;
  const events = [];
  setTimeout(() => {
    console.log('TONE SPAWNED at t+' + (Date.now() - t0) + 'ms');
    spawn('/usr/bin/paplay', ['/tmp/tone440.wav'], { stdio: 'ignore' });
  }, 800);
  for (let i = 0; i < 160; i++) {
    const r = await send('Runtime.evaluate', { expression: "window.__kasmAudioLevel()", returnByValue: true });
    const db = (r.result && r.result.value !== undefined) ? r.result.value : null;
    const now = Date.now();
    if (db !== null && db !== last) {
      events.push({ t: now - t0, db });
      if (events.length <= 20) console.log('t+' + (now - t0) + 'ms db=' + db);
      last = db;
    }
    await new Promise(r2 => setTimeout(r2, 40));
  }
  console.log('EVENTS:', JSON.stringify(events));
  process.exit(0);
})();
