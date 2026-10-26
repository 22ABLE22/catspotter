/**
 * app.js — 页面交互与动效
 *
 * 功能契约（与旧版一致，不得破坏）：
 *   点击选择 / 整页拖拽 / Ctrl·⌘+V 粘贴 → analyze() 本地求解 →
 *   裁出棋盘并圈出猫位 → 元信息 + 坐标列表 → 复制 / 换一张 / 行内报错。
 *
 * 动效（design-to-motion · 网站语境）：
 *   - 首屏演示盘：入场一次（IntersectionObserver，30% 可见触发），
 *     之后故事循环常驻；离开视口暂停，回来续播。
 *   - 标语逐词显现：每字从约 28% 透明度按阅读序点亮，只播一次。
 *   - 滚动入场：reveal 元素上升 32px 淡入，播一次不重播。
 *   - prefers-reduced-motion：全部直接呈现最终状态，无循环。
 *   时间一律由单一 JS 时钟（rAF 的 loop time）驱动，静止帧等于设计稿。
 */
import { analyze } from './cat-solver.js';

const $ = id => document.getElementById(id);
const drop = $('drop');
const fileInput = $('file');
const loading = $('loading');
const errBox = $('error');
const result = $('result');
const panelResult = $('panel-result');
const metaBox = $('meta');
const coordsBox = $('coords');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let lastResult = null;

/* ============================================================ 文件入口 */

function openPicker() { fileInput.click(); }

drop.addEventListener('click', openPicker);
drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
});
fileInput.addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (f) load(f);
  fileInput.value = '';
});

// 首屏与尾部的行动按钮：若已有结果先复位，再打开选择器
for (const id of ['heroPick', 'finalPick']) {
  const btn = $(id);
  if (btn) btn.addEventListener('click', () => {
    if (!result.classList.contains('hidden') || !panelResult.classList.contains('hidden')) resetToDrop(false);
    openPicker();
  });
}

// 整页都能接收拖拽，避免上传区隐藏后失效
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => {
  e.preventDefault();
  if (!drop.classList.contains('hidden')) drop.classList.add('over');
}));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => {
  e.preventDefault();
  if (e.target === document || e.target === document.documentElement) drop.classList.remove('over');
}));
document.addEventListener('drop', e => {
  drop.classList.remove('over');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) load(f);
});

window.addEventListener('paste', e => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  const item = Array.from(items).find(i => i.type && i.type.startsWith('image/'));
  if (item) {
    const f = item.getAsFile();
    if (f) load(f);
  }
});

$('again').addEventListener('click', () => resetToDrop(true));

function resetToDrop(scroll) {
  result.classList.add('hidden');
  panelResult.classList.add('hidden');
  loading.classList.add('hidden');
  errBox.classList.add('hidden');
  drop.classList.remove('hidden');
  if (scroll) drop.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
}

$('copy').addEventListener('click', async () => {
  if (!lastResult) return;
  const text = formatText(lastResult);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const btn = $('copy');
  btn.textContent = '已复制 ✓';
  setTimeout(() => { btn.textContent = '复制坐标'; }, 1500);
});

/* ============================================================ 主流程 */

async function load(file) {
  errBox.classList.add('hidden');
  drop.classList.add('hidden');
  result.classList.add('hidden');
  panelResult.classList.add('hidden');
  loading.classList.remove('hidden');           // 骨架加载态，形状贴合结果卡
  try {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bmp = await createImageBitmap(file);
    }
    // 让骨架先画出一帧，再做同步计算
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    run(bmp);
  } catch (err) {
    showError('图片读取失败：' + (err && err.message ? err.message : err));
  }
}

function run(bmp) {
  const off = document.createElement('canvas');
  off.width = bmp.width;
  off.height = bmp.height;
  const octx = off.getContext('2d', { willReadFrequently: true });
  octx.drawImage(bmp, 0, 0);
  const imgData = octx.getImageData(0, 0, bmp.width, bmp.height);

  let res;
  const t0 = performance.now();
  try {
    res = analyze(imgData);
  } catch (err) {
    showError((err && err.message ? err.message : String(err)) + '（若图片被裁剪或遮挡，换一张完整截图即可）');
    return;
  }
  res.ms = Math.round(performance.now() - t0);

  lastResult = res;
  loading.classList.add('hidden');
  drawBoard(bmp, res);
  renderMeta(res);
  renderCoords(res);
  result.classList.remove('hidden');
  panelResult.classList.remove('hidden');
}

/** 只画棋盘区域：按格子外框裁剪，去掉截图中不相干的界面部分 */
function drawBoard(bmp, res) {
  const { n, boxes, cells } = res;
  const [bx0, by0, bx1, by1] = res.board;
  const pad = 2;
  const w = bx1 - bx0 + 1 + pad * 2;
  const h = by1 - by0 + 1 + pad * 2;

  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(bmp, -(bx0 - pad), -(by0 - pad));

  const cell = Math.min(w, h) / n;
  ctx.lineWidth = Math.max(2, Math.round(cell * 0.06));
  ctx.strokeStyle = '#ff2d2d';
  ctx.lineJoin = 'round';
  for (const [r, c] of cells) {
    const [x0, y0, x1, y1] = boxes[r * n + c];
    const cx = (x0 + x1) / 2 - bx0 + pad;
    const cy = (y0 + y1) / 2 - by0 + pad;
    const rad = (Math.min(x1 - x0, y1 - y0) / 2) * 0.92;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
  }
  canvas.setAttribute('aria-label', `已标注 ${res.n}×${res.n} 棋盘与 ${res.coords.length} 只小猫的位置`);
}

function renderMeta(res) {
  metaBox.innerHTML = '';
  const add = (text, warn) => {
    const s = document.createElement('span');
    s.className = 'chip' + (warn ? ' warn' : '');
    s.textContent = text;
    metaBox.appendChild(s);
  };
  add(`棋盘 ${res.n} × ${res.n}`);
  add(res.unique ? '唯一解' : `${res.solutionCount} 个合法解，已给出第一个`);
  add(`耗时 ${res.ms} ms`);
  (res.warnings || []).forEach(w => add(w, true));
}

function renderCoords(res) {
  coordsBox.innerHTML = '';
  for (const { x, y } of res.coords) {
    const d = document.createElement('span');
    d.className = 'coord';
    d.innerHTML = `列 <b>${x}</b> 行 <b>${y}</b>`;
    coordsBox.appendChild(d);
  }
}

function formatText(res) {
  const line = res.coords.map(({ x, y }) => `(${x},${y})`).join(' ');
  return `${res.n}×${res.n} 小猫坐标：\n${line}`;
}

function showError(msg) {
  loading.classList.add('hidden');
  errBox.textContent = msg;
  errBox.classList.remove('hidden');
  result.classList.add('hidden');
  panelResult.classList.add('hidden');
  drop.classList.remove('hidden');
}

/* ============================================================ 滚动入场 */

function observeOnce(nodes, onEnter, threshold = 0.3) {
  if (!('IntersectionObserver' in window)) { nodes.forEach(onEnter); return; }
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (en.isIntersecting) { onEnter(en.target); io.unobserve(en.target); }
    }
  }, { threshold });
  nodes.forEach(n => io.observe(n));
}

observeOnce([...document.querySelectorAll('.reveal')], el => el.classList.add('in'));

/* ============================================================ 标语逐词 */

for (const line of document.querySelectorAll('[data-words]')) {
  const text = line.textContent.trim();
  line.textContent = '';
  [...text].forEach((ch, i) => {
    const s = document.createElement('span');
    s.className = 'w';
    s.textContent = ch;
    s.style.setProperty('--d', `${Math.min(i * 26, 900)}ms`);
    line.appendChild(s);
  });
}
observeOnce([...document.querySelectorAll('[data-words]')], el => el.classList.add('in'));

/* ============================================================ 首屏演示 */
/**
 * 6×6 演示盘：颜色区域由 6 只猫的位置做多源 BFS 生长而成——每块区域四连通
 * 且恰含一只猫，与真实关卡的语义一致。猫位本身是一条合法解（每行每列一只、
 * 八邻互不相邻）。故事：扫描格沿猫位逐格巡行，每到一个位置猫标记落下并脉冲
 * 一次；全部落位后进度条填满，画面溶解回空态再循环。静止帧等于设计稿。
 */
(() => {
  const board = $('demoBoard');
  const status = $('demoStatus');
  if (!board) return;

  const N = 6;
  const COLORS = ['#e2654f', '#f2a65a', '#e9d268', '#7bb661', '#5aa9d6', '#9a7fd1'];
  const CATS = [[0, 0], [1, 2], [2, 4], [3, 1], [4, 3], [5, 5]];   // 行,列

  // 多源 BFS：猫格先占色，再向四邻生长，区域必然连通
  const owner = new Array(N * N).fill(-1);
  const queue = [];
  CATS.forEach(([r, c], i) => { owner[r * N + c] = i; queue.push([r, c, i]); });
  for (let h = 0; h < queue.length; h++) {
    const [r, c, i] = queue[h];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= N || nc >= N) continue;
      if (owner[nr * N + nc] === -1) { owner[nr * N + nc] = i; queue.push([nr, nc, i]); }
    }
  }

  const cells = [];
  for (let i = 0; i < N * N; i++) {
    const el = document.createElement('span');
    el.className = 'demo-cell';
    el.style.background = COLORS[owner[i]];
    // 入场按阅读序错峰：行×列波
    el.style.setProperty('--d', `${Math.min((Math.floor(i / N) + (i % N)) * 26, 900)}ms`);
    board.appendChild(el);
    cells.push(el);
  }

  const scan = document.createElement('span');
  scan.className = 'demo-scan';
  const ring = document.createElement('span');
  ring.className = 'demo-ring';
  board.appendChild(scan); board.appendChild(ring);

  const catEls = CATS.map(() => {
    const el = document.createElement('span');
    el.className = 'demo-cat';
    board.appendChild(el);
    return el;
  });

  const foot = document.querySelector('.demo-foot');
  const bar = document.createElement('span');
  bar.className = 'demo-bar';
  bar.innerHTML = '<i></i>';
  foot.appendChild(bar);
  const barFill = bar.firstElementChild;

  let centers = [];   // 每格中心（相对 board 的百分比）
  function measure() {
    const rect = board.getBoundingClientRect();
    if (!rect.width) return;
    centers = cells.map(el => {
      const r = el.getBoundingClientRect();
      return {
        x: (r.left - rect.left + r.width / 2) / rect.width * 100,
        y: (r.top - rect.top + r.height / 2) / rect.height * 100
      };
    });
  }
  measure();
  window.addEventListener('resize', measure);

  // 循环时间轴（秒）：入场 → 故事 → 进度 → 停留 → 溶解 → 空拍
  const T = {
    storyStart: 2.4, catStep: 0.62,
    get storyEnd() { return this.storyStart + CATS.length * this.catStep; },
    get barStart() { return this.storyEnd + 0.15; },
    get barEnd() { return this.barStart + 0.7; },
    get holdEnd() { return this.barEnd + 0.8; },
    get dissolveEnd() { return this.holdEnd + 0.7; },
    get cycle() { return this.dissolveEnd + 0.6; }
  };

  const easeInOut = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const centerOf = rc => centers[rc[0] * N + rc[1]] || { x: 0, y: 0 };
  // 元素宽为 board 的 15.5%：把中心移到 (x,y)% 需要自身百分比位移
  // tx = x/0.155 − 50。位置与缩放全部走 transform，不碰 left/top。
  const EL = 0.155;
  const moveTo = (x, y) => `translate(${x / EL * 100 - 50}%, ${y / EL * 100 - 50}%)`;

  function drawFrame() {
    if (!centers.length) { measure(); return; }
    const dissolving = lt >= T.holdEnd;
    board.classList.toggle('in', !dissolving);
    board.classList.toggle('out', dissolving);

    // 扫描格：只在故事期出现，沿猫位巡行
    if (lt >= T.storyStart && lt < T.storyEnd && !dissolving) {
      const p = (lt - T.storyStart) / (T.catStep * CATS.length);
      const seg = Math.min(CATS.length - 1, Math.floor(p * CATS.length));
      const k = easeInOut(Math.min(1, p * CATS.length - seg));
      const a = centerOf(CATS[seg]);
      const b = centerOf(CATS[Math.min(CATS.length - 1, seg + 1)]);
      scan.style.opacity = '1';
      scan.style.transform = moveTo(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
    } else {
      scan.style.opacity = '0';
    }

    // 猫：到点落下（scale .84→1 + 淡入），最近落位的一只脉冲一次光环
    let landed = 0;
    CATS.forEach((rc, i) => {
      const at = T.storyStart + (i + 1) * T.catStep;
      const el = catEls[i];
      const on = lt >= at && !dissolving;
      if (on) {
        landed = i + 1;
        const age = Math.min(1, (lt - at) / 0.34);
        el.style.opacity = String(easeInOut(age));
        el.style.transform = `${moveTo(centerOf(rc).x, centerOf(rc).y)} scale(${0.84 + 0.16 * easeInOut(age)})`;
      } else {
        el.style.opacity = '0';
        el.style.transform = `${moveTo(centerOf(rc).x, centerOf(rc).y)} scale(.84)`;
      }
    });
    const lastAt = T.storyStart + landed * T.catStep;
    if (landed > 0 && !dissolving && lt - lastAt < 0.5) {
      const age = (lt - lastAt) / 0.5;
      const p = centerOf(CATS[landed - 1]);
      ring.style.opacity = String(0.55 * (1 - age));
      ring.style.transform = `${moveTo(p.x, p.y)} scale(${1 + 1.6 * age})`;
    } else {
      ring.style.opacity = '0';
    }

    // 进度条：落位齐后从左向右填满（scaleX，只动 transform）；溶解期收回
    if (lt >= T.barStart && lt < T.holdEnd) {
      const k = Math.min(1, (lt - T.barStart) / (T.barEnd - T.barStart));
      barFill.style.transform = `scaleX(${easeInOut(k)})`;
    } else if (lt >= T.holdEnd && lt < T.dissolveEnd) {
      const k = 1 - (lt - T.holdEnd) / (T.dissolveEnd - T.holdEnd);
      barFill.style.transform = `scaleX(${k})`;
    } else if (lt < T.barStart) {
      barFill.style.transform = 'scaleX(0)';
    }

    // 状态文案随阶段变化（保持短，与进度条同行）
    if (dissolving) status.textContent = '演示重播中…';
    else if (lt >= T.barStart) status.textContent = `已定位 ${CATS.length}/${CATS.length} · 唯一解`;
    else if (lt >= T.storyStart) status.textContent = `已定位 ${landed}/${CATS.length} · 校验规则`;
    else if (lt >= T.storyStart - 1.2) status.textContent = '扫描颜色分区…';
    else status.textContent = '读取截图 · 定位棋盘';
  }

  let lt = 0, raf = 0, visible = false, lastTs = 0;

  function tick(ts) {
    if (!visible) { raf = 0; return; }
    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 0;
    lastTs = ts;
    lt = (lt + dt) % T.cycle;
    drawFrame();
    raf = requestAnimationFrame(tick);
  }
  function startLoop() {
    if (visible || reducedMotion.matches) return;
    visible = true; lastTs = 0;
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function stopLoop() { visible = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  function finalState() {   // 降低动效：直接呈现终态，无循环
    measure();
    board.classList.remove('out');
    board.classList.add('in');
    CATS.forEach((rc, i) => {
      const p = centerOf(rc);
      catEls[i].style.opacity = '1';
      catEls[i].style.transform = `${moveTo(p.x, p.y)} scale(1)`;
    });
    barFill.style.transform = 'scaleX(1)';
    status.textContent = `已定位 ${CATS.length}/${CATS.length} · 唯一解`;
  }

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (reducedMotion.matches) { finalState(); return; }
        if (en.isIntersecting) startLoop(); else stopLoop();
      }
    }, { threshold: 0.3 });
    io.observe(board);
  } else if (reducedMotion.matches) {
    finalState();
  } else {
    startLoop();
  }
  reducedMotion.addEventListener('change', e => { if (e.matches) { stopLoop(); finalState(); } });
})();
