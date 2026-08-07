const CDP = 'http://127.0.0.1:9222';
const url = 'http://127.0.0.1:8000/test-audio.html' + (process.argv[2] || '');
(async () => {
  const target = await (await fetch(CDP + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const msgs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map(a => a.value !== undefined ? JSON.stringify(a.value) : a.description || a.type).join(' ');
      msgs.push('console.' + m.params.type + ': ' + args);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      msgs.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails));
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => ws.onopen = r);
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 12000));
  const r = await send('Runtime.evaluate', {
    expression: "(document.getElementById('kasmAudioStatus')?document.getElementById('kasmAudioStatus').textContent:'NO STATUS') + ' || dbg=' + JSON.stringify(window.__kasmAudioDebug()) + ' || spec=' + JSON.stringify(window.__kasmAudioSpectrum())",
    returnByValue: true
  });
  console.log('STATUS:', r.result.value);
  console.log('CONSOLE:', msgs.slice(-15).join('\n'));
  process.exit(0);
})();
