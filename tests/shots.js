// 截图：桌面首屏 / 桌面全页 / 移动首屏（CDP，无依赖）
'use strict';
const net = require('net'), http = require('http'), crypto = require('crypto');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');

const ROOT = path.dirname(path.dirname(__filename));
const PORT = 8148, CDP = 9348;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    let f = p === '/' ? path.join(ROOT, 'docs', 'index.html')
        : p.startsWith('/example/') ? path.join(ROOT, p)
        : path.join(ROOT, 'docs', p);
    f = path.normalize(f);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
});
function httpJson(p) {
    return new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: CDP, path: p }, r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
        }).on('error', rej);
    });
}
function connect(url) {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const sock = net.connect(Number(u.port), u.hostname, () => {
            sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        });
        let buf = Buffer.alloc(0), upgraded = false; const handlers = {};
        const client = { send: null, on: null, close: () => sock.destroy() };
        sock.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            if (!upgraded) {
                const idx = buf.indexOf('\r\n\r\n'); if (idx < 0) return;
                if (!/101/.test(buf.slice(0, idx).toString())) return reject(new Error('upgrade failed'));
                buf = buf.slice(idx + 4); upgraded = true; resolve(client);
            }
            while (buf.length >= 2) {
                const masked = (buf[1] & 0x80) !== 0; let len = buf[1] & 0x7f, off = 2;
                if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
                else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
                const ml = masked ? 4 : 0; if (buf.length < off + ml + len) return;
                let payload = buf.slice(off + ml, off + ml + len);
                if (masked) { const m = buf.slice(off, off + 4); payload = Buffer.from(payload.map((v, i) => v ^ m[i % 4])); }
                buf = buf.slice(off + ml + len); if (handlers.message) handlers.message(payload.toString());
            }
        });
        sock.on('error', reject);
        client.on = (ev, fn) => { if (ev === 'message') handlers.message = fn; };
        client.send = obj => {
            const data = Buffer.from(JSON.stringify(obj)), mask = crypto.randomBytes(4);
            let header;
            if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
            else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
            else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
            sock.write(Buffer.concat([header, mask, Buffer.from(data.map((v, i) => v ^ mask[i % 4]))]));
        };
    });
}
(async () => {
    await new Promise(r => server.listen(PORT, r));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-shot-'));
    const browser = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
    const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
    let tabs = null;
    for (let i = 0; i < 40; i++) { try { tabs = await httpJson('/json/list'); if (tabs && tabs.length) break; } catch (e) {} await sleep(250); }
    const ws = await connect(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    let id = 0; const pend = new Map();
    ws.on('message', m => { const o = JSON.parse(m); if (o.id && pend.has(o.id)) { const p = pend.get(o.id); pend.delete(o.id); o.error ? p.rej(new Error(JSON.stringify(o.error))) : p.res(o.result); } });
    const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send({ id: i, method, params: params || {} }); });
    await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(2600);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const shot1 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(os.tmpdir(), 'shot-desktop-hero.png'), Buffer.from(shot1.data, 'base64'));
    // 全页
    const metrics = await send('Page.getLayoutMetrics');
    const w = Math.ceil(metrics.cssContentSize.width), h = Math.ceil(metrics.cssContentSize.height);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(os.tmpdir(), 'shot-desktop-full.png'), Buffer.from(shot2.data, 'base64'));
    // 移动
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(2600);
    const shot3 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(os.tmpdir(), 'shot-mobile-hero.png'), Buffer.from(shot3.data, 'base64'));
    ws.close(); proc.kill(); server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    console.log('shots saved: shot-desktop-hero.png shot-desktop-full.png shot-mobile-hero.png');
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
