/**
 * cat-solver.js — n×n 找猫求解器核心算法（纯 JS，不依赖 DOM）
 *
 * 与 py-version/solver.py 一一对应：
 *   1) 定位棋盘：按饱和度取"彩色"像素，对行/列投影找出等间距条带，得到 n 与每格边界
 *   2) 识别颜色：采样每格中心颜色，自适应容差聚类成 n 种颜色，再做四连通检查
 *   3) 求解：位掩码 + 回溯（最小剩余值），规则为
 *        每种颜色 1 只猫、每行每列 1 只猫、任意两只猫八邻不相邻
 */

const SAT_MIN = 35;        // 判定"彩色"的饱和度阈值
const MIN_BAND = 12;       // 条带最小像素高度/宽度
const CLUSTER_TOLS = [30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 9, 8, 7, 6, 5, 4];
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/* ------------------------------------------------------------ 小工具 */

function runs(mask) {
  const out = [];
  let start = null;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && start === null) start = i;
    else if (!mask[i] && start !== null) { out.push([start, i - 1]); start = null; }
  }
  if (start !== null) out.push([start, mask.length - 1]);
  return out;
}

function median(values) {
  const v = Array.from(values).sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function popcount32(v) {
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  v = (v + (v >> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >> 24;
}

function popcount(x) {
  let c = 0;
  while (x > 0n) { c += popcount32(Number(x & 0xffffffffn)); x >>= 32n; }
  return c;
}

/** 最低位 1 的下标（low 必须是 2 的幂） */
function lowIndex(low) {
  let i = 0;
  let v = low;
  while (v > 0xffffffffn) { v >>= 32n; i += 32; }
  let x = Number(v);
  while ((x & 1) === 0) { x >>= 1; i++; }
  return i;
}

/* ------------------------------------------------------------ 1. 定位棋盘 */

/** 从若干条带中挑出等间距、等宽度的最长连续序列（滤掉 UI 文字/图标干扰） */
function pickSeries(bands) {
  if (!bands.length) return [];
  const widths = bands.map(b => b[1] - b[0] + 1).sort((a, b) => a - b);
  const medW = median(widths);
  let best = [];
  for (let i = 0; i < bands.length; i++) {
    const series = [bands[i]];
    for (let j = i + 1; j < bands.length; j++) {
      const p0 = series[series.length - 1][0] - series[0][0];
      const pitch = series.length > 1 ? p0 / (series.length - 1) : null;
      const gap = bands[j][0] - series[series.length - 1][0];
      const w = bands[j][1] - bands[j][0] + 1;
      const okW = w >= 0.6 * medW && w <= 1.5 * medW;
      const okP = pitch === null || Math.abs(gap - pitch) <= 0.25 * pitch;
      if (okW && okP) series.push(bands[j]);
      else if (pitch !== null && gap > 1.6 * pitch) break;
    }
    if (series.length > best.length) best = series;
  }
  return best;
}

function bands(counts, thresh) {
  return runs(counts.map(c => c > thresh)).filter(b => b[1] - b[0] >= MIN_BAND);
}

/** 找出棋盘的行列条带；imageData 形如 {data: Uint8ClampedArray, width, height} */
export function detectGrid(imageData) {
  const { data, width, height } = imageData;
  const colored = new Uint8Array(width * height);
  const rowCnt = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let c = 0;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat > SAT_MIN) { colored[y * width + x] = 1; c++; }
    }
    rowCnt[y] = c;
  }

  const maxOf = arr => { let m = 0; for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i]; return m; };
  const maxRow = maxOf(rowCnt);
  let best = null;
  for (const frac of [0.45, 0.35, 0.55, 0.30, 0.60]) {
    const rows = pickSeries(bands(rowCnt, maxRow * frac));
    if (!rows.length) continue;
    const y0 = rows[0][0], y1 = rows[rows.length - 1][1];
    const colCnt = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      let c = 0;
      for (let y = y0; y <= y1; y++) c += colored[y * width + x];
      colCnt[x] = c;
    }
    const maxCol = maxOf(colCnt);
    const cols = pickSeries(bands(colCnt, maxCol * frac));
    if (!cols.length) continue;
    if (rows.length === cols.length) { best = { rows, cols }; break; }
  }
  if (!best) throw new Error('未能识别出棋盘格子，请确认截图包含完整的 n×n 网格');
  return best;
}

/* ------------------------------------------------------------ 2. 颜色聚类 */

function clusterOnce(colors, tol) {
  const clusters = [];               // {mean:[r,g,b], members:[idx]}
  const assign = new Array(colors.length).fill(0);
  colors.forEach((c, i) => {
    let hit = -1;
    for (let k = 0; k < clusters.length; k++) {
      const m = clusters[k].mean;
      let ok = true;
      for (let t = 0; t < 3; t++) {
        if (Math.abs(Math.trunc(m[t]) - Math.trunc(c[t])) > tol) { ok = false; break; }
      }
      if (ok) { hit = k; break; }
    }
    if (hit < 0) {
      clusters.push({ mean: c.slice(), members: [i] });
      hit = clusters.length - 1;
    } else {
      const cl = clusters[hit];
      cl.members.push(i);
      cl.mean = [0, 1, 2].map(t => cl.members.reduce((s, m) => s + colors[m][t], 0) / cl.members.length);
    }
    assign[i] = hit;
  });

  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (let i = 0; i < colors.length; i++) {
      let bestK = 0, bestD = Infinity;
      for (let k = 0; k < clusters.length; k++) {
        const m = clusters[k].mean;
        const d = Math.max(Math.abs(m[0] - colors[i][0]), Math.abs(m[1] - colors[i][1]), Math.abs(m[2] - colors[i][2]));
        if (d < bestD) { bestD = d; bestK = k; }
      }
      if (bestK !== assign[i]) {
        clusters[assign[i]].members = clusters[assign[i]].members.filter(m => m !== i);
        clusters[bestK].members.push(i);
        assign[i] = bestK;
        changed = true;
      }
    }
    for (const cl of clusters) {
      if (cl.members.length) {
        cl.mean = [0, 1, 2].map(t => cl.members.reduce((s, m) => s + colors[m][t], 0) / cl.members.length);
      }
    }
    if (!changed) break;
  }
  return { assign, k: clusters.length };
}

/** 自适应容差：让聚类数正好等于 n */
function clusterAuto(colors, n, warnings) {
  let best = null;
  for (const tol of CLUSTER_TOLS) {
    const r = clusterOnce(colors, tol);
    if (r.k === n) return r;
    if (!best || Math.abs(r.k - n) < Math.abs(best.k - n)) best = r;
  }
  warnings.push(`颜色聚类得到 ${best.k} 种，与 ${n} 不一致，结果可能不准`);
  return best;
}

/* ------------------------------------------------------------ 棋盘读取 */

/** 截图 -> {n, regions(Int16Array), boxes}  regions[r*n+c]，r=0 是最上面一行 */
export function readGrid(imageData) {
  const warnings = [];
  const { data, width } = imageData;
  const { rows, cols } = detectGrid(imageData);
  const n = rows.length;

  const colors = [];
  const boxes = [];
  for (const [ry0, ry1] of rows) {
    for (const [cx0, cx1] of cols) {
      const h = Math.max(3, Math.floor((ry1 - ry0 + 1) * 0.35));
      const w = Math.max(3, Math.floor((cx1 - cx0 + 1) * 0.35));
      const cy = (ry0 + ry1) >> 1, cx = (cx0 + cx1) >> 1;
      const y0 = cy - (h >> 1), y1 = y0 + h;
      const x0 = cx - (w >> 1), x1 = x0 + w;
      const ch = [[], [], []];
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const p = (y * width + x) * 4;
          ch[0].push(data[p]); ch[1].push(data[p + 1]); ch[2].push(data[p + 2]);
        }
      }
      colors.push([median(ch[0]), median(ch[1]), median(ch[2])]);
      boxes.push([cx0, ry0, cx1, ry1]);
    }
  }

  const { assign, k } = clusterAuto(colors, n, warnings);
  if (k !== n) warnings.push(`按 ${n} 处理，请检查截图`);
  const regions = Int16Array.from(assign);

  // 棋盘整体外框（所有格子的并集），用于裁掉截图里不相干的界面部分
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [x0, y0, x1, y1] of boxes) {
    if (x0 < bx0) bx0 = x0;
    if (y0 < by0) by0 = y0;
    if (x1 > bx1) bx1 = x1;
    if (y1 > by1) by1 = y1;
  }
  const board = [bx0, by0, bx1, by1];

  // 每种颜色必须连成一片；若被聚成多块，只保留最大连通块
  for (let key = 0; key < n; key++) {
    const { mask, comps } = connected(regions, n, key);
    if (comps > 1) {
      warnings.push(`颜色 ${key + 1} 不连通（${comps} 块），已取最大块`);
      for (let i = 0; i < regions.length; i++) {
        if (regions[i] === key && !mask[i]) regions[i] = -1;
      }
    }
  }
  return { n, regions, boxes, board, warnings };
}

/** 检查某个编号的区域是否四连通，返回最大连通块掩码与连通块数量 */
function connected(regions, n, key) {
  const mask = new Uint8Array(n * n);
  const seen = new Uint8Array(n * n);
  const comps = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (regions[i] !== key || seen[i]) continue;
      const stack = [i];
      const cur = [];
      seen[i] = 1;
      while (stack.length) {
        const p = stack.pop();
        cur.push(p);
        const y = (p / n) | 0, x = p % n;
        for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= n || nx < 0 || nx >= n) continue;
          const q = ny * n + nx;
          if (regions[q] === key && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
      comps.push(cur);
    }
  }
  if (!comps.length) return { mask, comps: 0 };
  comps.sort((a, b) => b.length - a.length);
  for (const i of comps[0]) mask[i] = 1;
  return { mask, comps: comps.length };
}

/* ------------------------------------------------------------ 3. 求解 */

/**
 * 规则求解，返回找到的解（最多 limit 个）
 * 关键：猫只占所在颜色区域里的一格，冲突只按"该格子的邻居"计算，
 *       不能按整个颜色区域的邻居并集来算（那是过度约束，会把有解判成无解）。
 */
export function solve(n, regions, limit = 50) {
  const regs = Array.from(new Set(Array.from(regions))).filter(k => k >= 0).sort((a, b) => a - b);
  const cand = new Map();
  for (const k of regs) cand.set(k, 0n);
  for (let i = 0; i < n * n; i++) {
    const k = regions[i];
    if (k >= 0) cand.set(k, cand.get(k) | (1n << BigInt(i)));
  }

  const nbr = new Array(n * n).fill(0n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let m = 0n;
      for (const [dy, dx] of DIRS8) {
        const ny = r + dy, nx = c + dx;
        if (ny >= 0 && ny < n && nx >= 0 && nx < n) m |= 1n << BigInt(ny * n + nx);
      }
      nbr[r * n + c] = m;
    }
  }

  const rowMask = [], colMask = [];
  for (let r = 0; r < n; r++) {
    let m = 0n;
    for (let c = 0; c < n; c++) m |= 1n << BigInt(r * n + c);
    rowMask.push(m);
  }
  for (let c = 0; c < n; c++) {
    let m = 0n;
    for (let r = 0; r < n; r++) m |= 1n << BigInt(r * n + c);
    colMask.push(m);
  }

  const solutions = [];
  const state = { forbid: 0n, row: 0n, col: 0n, placed: [] };

  function available(k) {
    return cand.get(k) & ~state.forbid & ~state.row & ~state.col;
  }

  function rec(remaining) {
    if (!remaining.length) {
      solutions.push(state.placed.slice());
      return solutions.length >= limit;
    }
    let bestK = null, bestM = 0n, bestCnt = Infinity;
    for (const k of remaining) {
      const m = available(k);
      const cnt = popcount(m);
      if (cnt < bestCnt) { bestK = k; bestM = m; bestCnt = cnt; if (cnt === 0) break; }
    }
    if (bestCnt === 0) return false;

    const rest = remaining.filter(k => k !== bestK);
    let m = bestM;
    while (m) {
      const low = m & -m;
      m ^= low;
      const p = lowIndex(low);
      const r = (p / n) | 0, c = p % n;
      const saved = [state.forbid, state.row, state.col];
      state.forbid |= low | nbr[p];      // 只禁这一格的邻居
      state.row |= rowMask[r];
      state.col |= colMask[c];
      state.placed.push([r, c]);
      if (rec(rest)) return true;
      state.placed.pop();
      [state.forbid, state.row, state.col] = saved;
    }
    return false;
  }

  rec(regs);
  return solutions;
}

/** 用独立逻辑校验解是否符合三条规则 */
export function validate(n, regions, cells) {
  const rs = cells.map(([r]) => r).sort((a, b) => a - b);
  const cs = cells.map(([, c]) => c).sort((a, b) => a - b);
  for (let i = 0; i < n; i++) {
    if (rs[i] !== i) throw new Error('行约束不满足');
    if (cs[i] !== i) throw new Error('列约束不满足');
  }
  if (new Set(cells.map(([r, c]) => regions[r * n + c])).size !== n) throw new Error('颜色约束不满足');
  const set = new Set(cells.map(([r, c]) => r * n + c));
  for (const [r, c] of cells) {
    for (const [dy, dx] of DIRS8) {
      const ny = r + dy, nx = c + dx;
      if (ny < 0 || ny >= n || nx < 0 || nx >= n) continue;
      if (set.has(ny * n + nx)) throw new Error(`两只猫相邻: (${r},${c})-(${ny},${nx})`);
    }
  }
}

/* ------------------------------------------------------------ 完整流程 */

/**
 * 从图像数据求解，返回
 * { n, coords:[{x,y}], cells:[[r,c]], unique, solutionCount, regions, boxes, board, warnings }
 * board = [x0,y0,x1,y1] 为棋盘整体外框（用于裁剪展示）
 * 坐标与游戏内一致：x=列(左→右 1..n)，y=行(下→上 1..n)，左下角为 (1,1)
 */
export function analyze(imageData) {
  const { n, regions, boxes, board, warnings } = readGrid(imageData);
  const solutions = solve(n, regions, 50);
  if (!solutions.length) {
    throw new Error('无解：请确认截图完整、棋盘颜色清晰（也可能识别出了错误的格子）');
  }
  const cells = solutions[0];
  validate(n, regions, cells);
  const coords = cells.map(([r, c]) => ({ x: c + 1, y: n - r })).sort((a, b) => a.x - b.x);
  return {
    n,
    cells,
    coords,
    unique: solutions.length === 1,
    solutionCount: solutions.length,
    regions,
    boxes,
    board,
    warnings,
  };
}
