/**
 * app.js — 页面交互：读取截图 -> 调用 cat-solver 核心 -> 裁出 n×n 棋盘并圈出小猫
 * 全程在浏览器本地完成，图片不会上传。
 */
import { analyze } from './cat-solver.js';

const $ = id => document.getElementById(id);
const drop = $('drop');
const fileInput = $('file');
const errBox = $('error');
const result = $('result');
const panelResult = $('panel-result');
const metaBox = $('meta');
const coordsBox = $('coords');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

let lastResult = null;

/* ---------------------------------------------------------- 选择文件 */

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

$('again').addEventListener('click', () => {
  result.classList.add('hidden');
  panelResult.classList.add('hidden');
  errBox.classList.add('hidden');
  drop.classList.remove('hidden');
  drop.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

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
  $('copy').textContent = '已复制 ✓';
  setTimeout(() => { $('copy').textContent = '复制坐标'; }, 1500);
});

/* ---------------------------------------------------------- 主流程 */

async function load(file) {
  errBox.classList.add('hidden');
  try {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bmp = await createImageBitmap(file);
    }
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
  drawBoard(bmp, res);
  renderMeta(res);
  renderCoords(res);
  drop.classList.add('hidden');
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
  errBox.textContent = msg;
  errBox.classList.remove('hidden');
  result.classList.add('hidden');
  panelResult.classList.add('hidden');
  drop.classList.remove('hidden');
}
