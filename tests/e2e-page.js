// Catspotter 功能回归（无头浏览器 + CDP，零 npm 依赖）
// 1) 起静态服务器 2) 启动 Edge/Chrome 3) 打开页面：
//    - 检查页面结构、动画元素、无 JS 报错
//    - 用 fetch+createImageBitmap 解码 example/*.jpg，走真实 analyze() 管线
//    - 断言 n、唯一性与坐标（与 README 预期一致）
'use strict';
const net = require('net'), http = require('http'), crypto = require('crypto');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');

const ROOT = path.dirname(path.dirname(__filename));
const PORT = Number(process.env.E2E_PORT || 8147);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9347);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer() {
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' };
    const srv = http.createServer((req, res) => {
        const p = decodeURIComponent(req.url.split('?')[0]);
        // 站点根 = docs/；/example/* 从仓库根取（真实 Pages 部署里不存在这条）
        let f;
        if (p === '/' || p === '/index.html') f = path.join(ROOT, 'docs', 'index.html');
        else if (p.startsWith('/example/')) f = path.join(ROOT, p);
        else f = path.join(ROOT, 'docs', p);
        f = path.normalize(f);
        if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
        res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
        res.end(fs.readFileSync(f));
    });
    return new Promise(resolve => srv.listen(PORT, () => resolve(srv)));
}

function findBrowser() {
    return [
        process.env.E2E_BROWSER,
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        '/usr/bin/google-chrome', '/usr/bin/chromium'
    ].filter(Boolean).find(p => fs.existsSync(p)) || null;
}

function httpJson(p) {
    return new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
            let d = ''; r.on('data', c => d += c);
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
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
        let buf = Buffer.alloc(0), upgraded = false;
        const handlers = {};
        const client = { send: null, on: null, close: () => sock.destroy() };
        sock.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            if (!upgraded) {
                const idx = buf.indexOf('\r\n\r\n');
                if (idx < 0) return;
                if (!/101/.test(buf.slice(0, idx).toString())) { reject(new Error('ws upgrade failed')); return; }
                buf = buf.slice(idx + 4); upgraded = true; resolve(client);
            }
            while (buf.length >= 2) {
                const masked = (buf[1] & 0x80) !== 0;
                let len = buf[1] & 0x7f, off = 2;
                if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
                else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
                const maskLen = masked ? 4 : 0;
                if (buf.length < off + maskLen + len) return;
                let payload = buf.slice(off + maskLen, off + maskLen + len);
                if (masked) { const m = buf.slice(off, off + 4); payload = Buffer.from(payload.map((v, i) => v ^ m[i % 4])); }
                buf = buf.slice(off + maskLen + len);
                if (handlers.message) handlers.message(payload.toString());
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

// README 预期：example01 = 16×16 唯一解，坐标列表见 README 示例输出
const EXPECT01 = [[1,8],[2,11],[3,15],[4,5],[5,10],[6,6],[7,4],[8,2],[9,7],[10,9],[11,13],[12,16],[13,14],[14,12],[15,3],[16,1]];

(async () => {
    const browser = findBrowser();
    if (!browser) { console.log('SKIP: no browser found'); process.exit(0); }
    const server = await startServer();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'catspotter-e2e-'));
    const proc = spawn(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
        '--window-size=1440,1000', 'about:blank'
    ], { stdio: 'ignore' });
    const cleanup = () => {
        try { proc.kill(); } catch (e) {}
        try { server.close(); } catch (e) {}
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    };
    let fails = 0;
    const check = (name, ok, extra) => {
        console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
        if (!ok) fails++;
    };
    try {
        let tabs = null;
        for (let i = 0; i < 40; i++) {
            try { tabs = await httpJson('/json/list'); if (tabs && tabs.length) break; } catch (e) {}
            await sleep(250);
        }
        const page = tabs.find(t => t.type === 'page');
        const ws = await connect(page.webSocketDebuggerUrl);
        let id = 0; const pend = new Map(); const errors = [];
        ws.on('message', m => {
            const o = JSON.parse(m);
            if (o.method === 'Runtime.exceptionThrown') errors.push(o.params.exceptionDetails.exception?.description || o.params.exceptionDetails.text);
            if (o.id && pend.has(o.id)) { const p = pend.get(o.id); pend.delete(o.id); o.error ? p.rej(new Error(JSON.stringify(o.error))) : p.res(o.result); }
        });
        const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send({ id: i, method, params: params || {} }); });
        const evaluate = async expr => {
            const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
            return r.result.value;
        };
        await send('Page.enable'); await send('Runtime.enable');
        await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
        await sleep(2500);

        // ---- 结构检查 ----
        const struct = await evaluate(`({
            title: document.title,
            hasFaqSchema: !!document.querySelector('script[type="application/ld+json"]'),
            hasNav: !!document.querySelector('.nav'),
            hasTool: !!document.querySelector('#tool'),
            hasTagline: !!document.querySelectorAll('[data-words]').length,
            hasHow: !!document.querySelector('#how'),
            hasFaq: document.querySelectorAll('.faq-item').length,
            hasFinalCta: !!document.querySelector('.final'),
            hasDemo: document.querySelectorAll('.demo-cell').length,
            revealIn: document.querySelectorAll('.reveal.in').length,
            revealTotal: document.querySelectorAll('.reveal').length,
            taglineIn: document.querySelectorAll('[data-words].in').length,
        })`);
        check('page title present', !!struct.title);
        check('FAQ schema (AEO)', struct.hasFaqSchema);
        check('nav / tool / how / faq / final sections', struct.hasNav && struct.hasTool && struct.hasHow && struct.hasFaq >= 8 && struct.hasFinalCta,
            `faq=${struct.hasFaq}`);
        check('demo board built (36 cells)', struct.hasDemo === 36, `cells=${struct.hasDemo}`);

        // 分步向下滚动触发 reveal 与 tagline（模拟真实浏览，每步留 IO 回调时间）
        await evaluate(`(async () => {
            const step = Math.round(window.innerHeight * 0.6);
            for (let y = 0; y <= document.body.scrollHeight; y += step) {
                window.scrollTo(0, y);
                await new Promise(r => setTimeout(r, 220));
            }
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise(r => setTimeout(r, 400));
            return true;
        })()`);
        await sleep(900);
        const after = await evaluate(`({
            revealIn: document.querySelectorAll('.reveal.in').length,
            revealTotal: document.querySelectorAll('.reveal').length,
            taglineIn: document.querySelectorAll('[data-words].in').length,
            taglineWords: document.querySelectorAll('[data-words] .w').length,
        })`);
        check('scroll reveals fired', after.revealIn === after.revealTotal && after.revealTotal >= 10, `${after.revealIn}/${after.revealTotal}`);
        check('tagline word-split active', after.taglineIn >= 2 && after.taglineWords > 20,
            `lines=${after.taglineIn} words=${after.taglineWords}`);
        await evaluate('window.scrollTo(0, 0)');

        // ---- 动画时钟推进检查：demo 猫在循环中改变状态 ----
        const anim = await evaluate(`(async () => {
            const cats = [...document.querySelectorAll('.demo-cat')];
            const snap = () => cats.map(c => c.style.opacity).join(',');
            const a = snap();
            await new Promise(r => setTimeout(r, 2500));
            const b = snap();
            return { changed: a !== b, anyVisible: [...cats].some(c => parseFloat(c.style.opacity) > 0.5) };
        })()`);
        check('demo story loop running', anim.changed && anim.anyVisible);

        // ---- 真实识别管线：3 张示例图 ----
        const results = await evaluate(`(async () => {
            const mod = await import('./cat-solver.js');
            const out = [];
            for (const f of ['example01.jpg','example02.jpg','example03.jpg']) {
                try {
                    const blob = await (await fetch('/example/' + f)).blob();
                    const bmp = await createImageBitmap(blob);
                    const off = new OffscreenCanvas(bmp.width, bmp.height);
                    const c2 = off.getContext('2d', { willReadFrequently: true });
                    c2.drawImage(bmp, 0, 0);
                    const res = mod.analyze(c2.getImageData(0, 0, bmp.width, bmp.height));
                    out.push({ f, ok: true, n: res.n, unique: res.unique, count: res.solutionCount,
                               coords: res.coords.map(c => [c.x, c.y]), ms: Math.round(performance.timeOrigin ? 0 : 0) });
                } catch (e) {
                    out.push({ f, ok: false, err: String(e && e.message || e) });
                }
            }
            return out;
        })()`);
        for (const r of results) {
            check(`${r.f} analyzed`, r.ok, r.ok ? `n=${r.n} unique=${r.unique} count=${r.count}` : r.err);
        }
        const e1 = results.find(r => r.f === 'example01.jpg');
        if (e1 && e1.ok) {
            check('example01 is 16×16', e1.n === 16);
            check('example01 unique solution', e1.unique === true);
            const same = JSON.stringify(e1.coords) === JSON.stringify(EXPECT01);
            check('example01 coords match README', same, same ? '' : JSON.stringify(e1.coords));
        }
        const e2 = results.find(r => r.f === 'example02.jpg');
        if (e2 && e2.ok) check('example01 fallback path: 12×12', e2.n === 12);
        const e3 = results.find(r => r.f === 'example03.jpg');
        if (e3 && e3.ok) check('example03 occluded path: 6×6', e3.n === 6);

        // ---- 交互：粘贴/换一张/复制按钮存在且状态切换可用 ----
        const ui = await evaluate(`({
            dropVisible: !document.getElementById('drop').classList.contains('hidden'),
            hasCopy: !!document.getElementById('copy'),
            hasAgain: !!document.getElementById('again'),
            hasSkel: !!document.getElementById('loading'),
        })`);
        check('tool UI intact', ui.dropVisible && ui.hasCopy && ui.hasAgain && ui.hasSkel);

        check('no page JS errors', errors.length === 0, errors.join(' | '));
        ws.close();
    } catch (e) {
        console.error('E2E ERROR:', e.message);
        fails++;
    }
    cleanup();
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nALL CHECKS PASSED');
    process.exit(fails ? 1 : 0);
})();
