/**
 * cat-solver.js — n×n 找猫求解器核心算法（纯 JS，不依赖 DOM）
 *
 * 与 py-version/solver.py 一一对应，流程：
 *   1) 定位棋盘：按饱和度取"彩色"像素，对行/列投影找出等间距条带，得到 n 与每格边界
 *   2) 多点采样投票：每格取中心 + 四象限共 5 个小块，各自求中位数颜色后投票取共识
 *   3) 颜色聚类（CIELAB + ΔE76）：自适应容差 + 自动拆分/合并，产出多种候选划分
 *   4) 自愈回路：按划分质量依次尝试，某个划分解不出就自动换下一种
 *   5) 求解：位掩码 + 前向检查 + 回溯（最小剩余值）
 *        规则：每种颜色 1 只猫、每行每列 1 只猫、任意两只猫八邻不相邻
 */

const SAT_MIN = 35;        // 判定"彩色"的饱和度阈值
const MIN_BAND = 12;       // 条带最小像素高度/宽度
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * CIELAB 容差阶梯（ΔE76），从宽松到严格。
 * 不再用固定容差：自愈回路会把每个容差产生的划分都作为候选，按质量排序后依次尝试。
 */
const LAB_TOLS = [30, 25, 20, 17, 14, 12, 10, 8.5, 7, 6, 5, 4, 3.5, 3, 2.5, 2, 1.5];

/** 多点采样：[相对格子中心的偏移 x, 偏移 y, 采样块边长占格子比例] */
const SAMPLE_OFFSETS = [
  [0, 0, 0.38],           // 中心
  [-0.20, -0.20, 0.26],   // 左上
  [0.20, -0.20, 0.26],    // 右上
  [-0.20, 0.20, 0.26],    // 左下
  [0.20, 0.20, 0.26],     // 右下
];
const VOTE_DELTA_E = 2.5;      // 投票时判定"同一种颜色"的 ΔE 阈值
const LOW_CONSISTENCY = 0.6;   // 低于此共识度的格子会被提示

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

/* ------------------------------------------------------------ 颜色空间 */

/** sRGB -> CIELAB(D65)。用感知均匀的 Lab 空间，相近颜色（浅粉/浅橙等）比 RGB 更好分 */
export function rgb2lab(rgb) {
  const f = v => {
    v /= 255;
    return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  };
  const r = f(rgb[0]), g = f(rgb[1]), b = f(rgb[2]);
  const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const Y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.0;
  const Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  const k = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = k(X), fy = k(Y), fz = k(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** ΔE76：Lab 空间的欧氏距离 */
export function deltaE(a, b) {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
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

/* ------------------------------------------------------------ 2. 多点采样投票 */

function patchMedian(data, width, x0, y0, x1, y1, step, out) {
  const ch = [[], [], []];
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const p = (y * width + x) * 4;
      ch[0].push(data[p]); ch[1].push(data[p + 1]); ch[2].push(data[p + 2]);
    }
  }
  out[0] = median(ch[0]); out[1] = median(ch[1]); out[2] = median(ch[2]);
  return out;
}

/**
 * 一格取 5 个小块，各自求中位数颜色，再用 ΔE 投票选出"共识色"。
 * 好处：某个小块不小心压到圆角/描边/邻格时，会被其余小块投票排除。
 * 返回 {rgb, lab, consistency, samples}，consistency 为共识度（0~1）。
 */
function sampleCell(data, width, cx0, ry0, cx1, ry1) {
  const cellW = cx1 - cx0 + 1, cellH = ry1 - ry0 + 1;
  const ccx = (cx0 + cx1) / 2, ccy = (ry0 + ry1) / 2;
  const rgbs = [], labs = [];
  for (const [ox, oy, side] of SAMPLE_OFFSETS) {
    const w = Math.max(3, Math.round(cellW * side));
    const h = Math.max(3, Math.round(cellH * side));
    const px = Math.round(ccx + ox * cellW);
    const py = Math.round(ccy + oy * cellH);
    let x0 = px - (w >> 1), y0 = py - (h >> 1);
    let x1 = x0 + w - 1, y1 = y0 + h - 1;
    if (x0 < cx0) { x0 = cx0; x1 = Math.min(cx1, x0 + w - 1); }
    if (y0 < ry0) { y0 = ry0; y1 = Math.min(ry1, y0 + h - 1); }
    if (x1 > cx1) { x1 = cx1; x0 = Math.max(cx0, x1 - w + 1); }
    if (y1 > ry1) { y1 = ry1; y0 = Math.max(ry0, y1 - h + 1); }
    const step = Math.max(1, Math.round(Math.min(w, h) / 12));   // 抽样步长，控制耗时
    const rgb = patchMedian(data, width, x0, y0, x1, y1, step, [0, 0, 0]);
    rgbs.push(rgb);
    labs.push(rgb2lab(rgb));
  }
  let bestI = 0, bestSupport = -1;
  for (let i = 0; i < labs.length; i++) {
    let support = 0;
    for (let j = 0; j < labs.length; j++) if (deltaE(labs[i], labs[j]) <= VOTE_DELTA_E) support++;
    if (support > bestSupport) { bestSupport = support; bestI = i; }
  }
  return { rgb: rgbs[bestI], lab: labs[bestI], consistency: bestSupport / labs.length, samples: rgbs };
}

/* ------------------------------------------------------------ 3. 颜色聚类 */

function meanLab(labs, members) {
  let L = 0, a = 0, b = 0;
  for (const m of members) { L += labs[m][0]; a += labs[m][1]; b += labs[m][2]; }
  const k = members.length;
  return [L / k, a / k, b / k];
}

/** 把划分整理成若干簇 {id, members, mean}（按 id 升序） */
function statsOf(assign, labs) {
  const ids = Array.from(new Set(assign)).sort((x, y) => x - y);
  return ids.map(id => {
    const members = [];
    for (let i = 0; i < assign.length; i++) if (assign[i] === id) members.push(i);
    return { id, members, mean: meanLab(labs, members) };
  });
}

/** 去掉空簇并重编号，使 id 落在 0..k-1 */
function compact(assign) {
  const ids = Array.from(new Set(assign)).sort((x, y) => x - y);
  const map = new Map(ids.map((v, i) => [v, i]));
  return assign.map(v => map.get(v));
}

/** 单次聚类：贪心生长 + 最多两轮"重分配到最近簇" */
function clusterOnce(labs, tol) {
  const clusters = [];
  const assign = new Array(labs.length).fill(0);
  labs.forEach((lab, i) => {
    let hit = -1;
    for (let k = 0; k < clusters.length; k++) {
      if (deltaE(lab, clusters[k].mean) <= tol) { hit = k; break; }
    }
    if (hit < 0) {
      clusters.push({ mean: lab.slice(), members: [i] });
      hit = clusters.length - 1;
    } else {
      clusters[hit].members.push(i);
      clusters[hit].mean = meanLab(labs, clusters[hit].members);
    }
    assign[i] = hit;
  });

  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (let i = 0; i < labs.length; i++) {
      let bestK = 0, bestD = Infinity;
      for (let k = 0; k < clusters.length; k++) {
        const d = deltaE(labs[i], clusters[k].mean);
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
      if (cl.members.length) cl.mean = meanLab(labs, cl.members);
    }
    if (!changed) break;
  }
  const a = compact(assign);
  return { assign: a, k: new Set(a).size };
}

/** 把簇数修到正好 n：多了就合并最相近的，少了就拆开最分散的 */
function repairTo(assign, labs, n) {
  let a = compact(assign);
  let guard = 0;
  while (new Set(a).size !== n && guard++ <= a.length + n) {
    const stats = statsOf(a, labs);
    const k = stats.length;
    if (k > n) {
      let bi = 0, bj = 1, bd = Infinity;
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          const d = deltaE(stats[i].mean, stats[j].mean);
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
      }
      const from = stats[bj].id, to = stats[bi].id;
      a = compact(a.map(v => (v === from ? to : v)));
    } else {
      // 拆开内部最分散的簇：以"离均值最远的点"和"离它最远的点"为种子做一次 2-means
      let pick = stats[0], pickSpread = -1;
      for (const st of stats) {
        let spread = 0;
        for (const m of st.members) spread = Math.max(spread, deltaE(labs[m], st.mean));
        if (spread > pickSpread) { pickSpread = spread; pick = st; }
      }
      let p1 = pick.members[0], d1 = -1;
      for (const m of pick.members) {
        const d = deltaE(labs[m], pick.mean);
        if (d > d1) { d1 = d; p1 = m; }
      }
      let p2 = p1, d2 = -1;
      for (const m of pick.members) {
        const d = deltaE(labs[m], labs[p1]);
        if (d > d2) { d2 = d; p2 = m; }
      }
      let c1 = labs[p1].slice(), c2 = labs[p2].slice();
      const side = new Map();
      for (let it = 0; it < 6; it++) {
        const g1 = [], g2 = [];
        for (const m of pick.members) {
          if (deltaE(labs[m], c1) <= deltaE(labs[m], c2)) { g1.push(m); side.set(m, 0); }
          else { g2.push(m); side.set(m, 1); }
        }
        if (!g1.length || !g2.length) break;
        c1 = meanLab(labs, g1);
        c2 = meanLab(labs, g2);
      }
      const newId = Math.max(...a) + 1;
      a = compact(a.map((v, i) => (v === pick.id && side.get(i) === 1 ? newId : v)));
    }
  }
  return new Set(a).size === n ? a : null;
}

/**
 * 划分质量：轮廓系数式评分，再乘以采样共识度。越大越好（约 -1 ~ 1）。
 *
 * 对每个簇算 a=簇内平均距离、b=到最近邻簇的平均距离，取 (b-a)/max(a,b) 求平均。
 * 比"簇间最小距离 / 簇内最大离散度"更细腻：后者只看两个全局极值，
 * 不同划分可能算出完全相同的分数，无法区分对错。
 */
function quality(assign, labs, consistency) {
  const stats = statsOf(assign, labs);
  const k = stats.length;
  let total = 0;
  for (const st of stats) {
    let a = 0;
    for (const m of st.members) a += deltaE(labs[m], st.mean);
    a /= st.members.length;
    let b = Infinity;
    for (const other of stats) {
      if (other === st) continue;
      let d = 0;
      for (const m of st.members) d += deltaE(labs[m], other.mean);
      d /= st.members.length;
      if (d < b) b = d;
    }
    if (!isFinite(b)) b = a;
    total += (b - a) / Math.max(a, b, 1e-6);
  }
  const sil = total / k;
  const consist = consistency && consistency.length
    ? consistency.reduce((s, v) => s + v, 0) / consistency.length : 1;
  return (sil + 1) * (0.5 + 0.5 * consist);
}

/** 产生候选划分：每个容差一种，去重后按质量从高到低排序 */
function clusterCandidates(labs, n, consistency) {
  const out = new Map();
  for (const tol of LAB_TOLS) {
    let assign = clusterOnce(labs, tol).assign;
    let repaired = false;
    if (new Set(assign).size !== n) {
      const fixed = repairTo(assign, labs, n);
      if (!fixed) continue;
      assign = fixed;
      repaired = true;
    }
    const sig = assign.join(',');
    if (out.has(sig)) {
      // 同一种划分，保留"未经修复"的标记（更可信）
      if (!repaired) out.get(sig).repaired = false;
      continue;
    }
    out.set(sig, { assign, repaired, score: Math.round(quality(assign, labs, consistency) * 1e6) / 1e6 });
  }
  // 质量高者优先；同分时优先"未经修复"的天然划分
  return Array.from(out.values()).sort((x, y) => (y.score - x.score) || (x.repaired - y.repaired));
}

/* ------------------------------------------------------------ 连通性 */

/** 检查某编号区域是否四连通，返回最大连通块掩码与连通块数量 */
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

/** 划分 -> 区域网格；若某种颜色不连通（游戏里不会发生）则该划分作废，返回 null */
function regionsFrom(assign, n, warnings) {
  const regions = Int16Array.from(assign);
  for (let key = 0; key < n; key++) {
    const { mask, comps } = connected(regions, n, key);
    if (comps > 1) {
      warnings.push(`颜色 ${key + 1} 被划成了 ${comps} 块，该划分作废`);
      return null;
    }
    if (comps === 0) return null;
  }
  return regions;
}

/* ------------------------------------------------------------ 4. 求解 */

/**
 * 位掩码 + 前向检查 + 回溯（最小剩余值），返回找到的解（最多 limit 个）
 *
 * 规则：每种颜色 1 只猫、每行每列 1 只猫、任意两只猫八邻不相邻。
 * 关键：猫只占所在颜色区域里的一格，冲突只按"该格子的邻居"计算，
 *       不能按整个颜色区域的邻居并集来算（那是过度约束，会把有解判成无解）。
 *
 * 前向检查：每放一只猫，立刻把被禁格子从其它颜色的候选集中剔除并检查空域，
 *           空域立即回退，比每层临时统计更早剪枝。
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
  const placed = [];
  const avail = new Map(cand);          // 每个颜色当前的候选格（前向检查维护）

  function rec(remaining) {
    if (!remaining.length) {
      solutions.push(placed.slice());
      return solutions.length >= limit;
    }
    // 最小剩余值：先处理候选最少的颜色
    let bestK = null, bestCnt = Infinity;
    for (const k of remaining) {
      const c = popcount(avail.get(k));
      if (c === 0) return false;
      if (c < bestCnt) { bestCnt = c; bestK = k; }
    }

    const rest = remaining.filter(k => k !== bestK);
    const saved = rest.map(k => avail.get(k));
    let m = avail.get(bestK);
    while (m) {
      const low = m & -m;
      m ^= low;
      const p = lowIndex(low);
      const r = (p / n) | 0, c = p % n;
      const removed = low | nbr[p] | rowMask[r] | colMask[c];

      // ---- 前向检查：把这一格的自身/邻居/整行/整列从其它颜色的候选里剔除 ----
      let ok = true;
      for (const k of rest) {
        const na = avail.get(k) & ~removed;
        avail.set(k, na);
        if (na === 0n) ok = false;
      }
      if (ok) {
        placed.push([r, c]);
        if (rec(rest)) return true;
        placed.pop();
      }
      rest.forEach((k, i) => avail.set(k, saved[i]));
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

/* ------------------------------------------------------------ 5. 完整流程 */

/** 棋盘整体外框（所有格子的并集），用于裁掉截图里不相干的界面部分 */
function boardBox(boxes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [a, b, c, d] of boxes) {
    if (a < x0) x0 = a;
    if (b < y0) y0 = b;
    if (c > x1) x1 = c;
    if (d > y1) y1 = d;
  }
  return [x0, y0, x1, y1];
}

/**
 * 从图像数据求解（含自愈回路），返回
 * { n, coords, cells, unique, solutionCount, regions, boxes, board, warnings, attempts, repaired }
 * 坐标与游戏内一致：x=列(左→右 1..n)，y=行(下→上 1..n)，左下角为 (1,1)
 */
export function analyze(imageData) {
  const warnings = [];
  const { rows, cols } = detectGrid(imageData);
  const n = rows.length;

  // 多点采样投票
  const samples = [];
  const boxes = [];
  for (const [ry0, ry1] of rows) {
    for (const [cx0, cx1] of cols) {
      samples.push(sampleCell(imageData.data, imageData.width, cx0, ry0, cx1, ry1));
      boxes.push([cx0, ry0, cx1, ry1]);
    }
  }
  const consistency = samples.map(s => s.consistency);
  const lowN = consistency.filter(c => c < LOW_CONSISTENCY).length;
  if (lowN) warnings.push(`${lowN} 个格子采样不一致，识别可能不稳`);
  const labs = samples.map(s => s.lab);
  const board = boardBox(boxes);

  // 候选划分（自愈回路的基础）
  const candidates = clusterCandidates(labs, n, consistency);
  if (!candidates.length) {
    throw new Error(`无法把颜色划分成 ${n} 种，请确认截图完整、颜色清晰`);
  }

  // 自愈回路：按质量依次尝试每种划分，解不出就换下一种
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const w = [];
    const regions = regionsFrom(cand.assign, n, w);
    if (!regions) continue;
    const solutions = solve(n, regions, 50);
    if (!solutions.length) continue;

    const cells = solutions[0];
    validate(n, regions, cells);
    if (i > 0) warnings.push(`前 ${i} 种颜色划分无解，已自动改用第 ${i + 1} 种`);
    if (cand.repaired) warnings.push('颜色划分经过自动合并/拆分修正');
    warnings.push(...w);
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
      attempts: i + 1,
      repaired: !!cand.repaired,
    };
  }

  throw new Error(`无解：已尝试 ${candidates.length} 种颜色划分方式仍未找到答案，请换一张清晰完整的截图`);
}
