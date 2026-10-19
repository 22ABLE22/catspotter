# -*- coding: utf-8 -*-
"""
Catspotter — 从游戏截图找出所有猫的位置
========================================
输入: 一张游戏截图(n*n 纯色格子, 每种颜色连成一片)
输出: n 只小猫的坐标 (列, 行), 与游戏内坐标一致(左下角为 (1,1))

适用关卡: 【数独爱消消】的「找猫」玩法(哔哩哔哩 / 微信小程序),
以及同一玩法的 Meowdoku (Google Play, com.oakever.meowdoku)。
本项目为第三方工具, 与上述游戏及其开发者没有任何关联。

游戏规则:
  1. 每种颜色仅有 1 只猫
  2. 每行每列仅有 1 只猫
  3. 任意两只猫不能相邻 —— 上下左右和对角线都不行(八邻);
     中间格子周围 8 格都不能有猫, 贴边 5 格, 贴角 3 格

算法要点(与网页版 docs/cat-solver.js 一致):
  * 多点采样投票: 每格取中心 + 四象限共 5 个小块, 各自求中位数颜色后投票取共识,
    某个小块压到圆角/描边时会被其余小块投票排除
  * CIELAB + ΔE76 聚类: 感知均匀的颜色空间, 相近色(浅粉/浅橙等)比 RGB 更好分
  * 自愈回路: 多个容差各产生一种颜色划分, 按轮廓系数评分排序后依次尝试,
    某个划分解不出就自动换下一种; 簇数不对时自动合并/拆分修正
  * 前向检查: 每放一只猫立刻把被禁格子从其它颜色的候选集中剔除并检查空域,
    空域立即回退, 比每层临时统计更早剪枝

用法:
  python solver.py 截图.jpg            # 打印坐标
  python solver.py 截图.jpg --mark     # 另存标注结果图, 自动命名为同名 .png
  python solver.py 截图.jpg --mark out.png  # 另存到指定路径
  python solver.py 截图.jpg --json     # 输出 JSON
"""

import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

SAT_MIN = 35                 # 判定"彩色"的饱和度阈值
MIN_BAND = 12                # 条带最小像素高度/宽度
DIRS8 = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))

# CIELAB 容差阶梯(ΔE76), 从宽松到严格; 自愈回路会逐个尝试
LAB_TOLS = (30, 25, 20, 17, 14, 12, 10, 8.5, 7, 6, 5, 4, 3.5, 3, 2.5, 2, 1.5)

# 多点采样: [相对格子中心的偏移 x, 偏移 y, 采样块边长占格子比例]
SAMPLE_OFFSETS = (
    (0.0, 0.0, 0.38),        # 中心
    (-0.20, -0.20, 0.26),    # 左上
    (0.20, -0.20, 0.26),     # 右上
    (-0.20, 0.20, 0.26),     # 左下
    (0.20, 0.20, 0.26),      # 右下
)
VOTE_DELTA_E = 2.5           # 投票时判定"同一种颜色"的 ΔE 阈值
LOW_CONSISTENCY = 0.6        # 低于此共识度的格子会被提示


# ---------------------------------------------------------------- 小工具

def _round(v):
    """与 JS 的 Math.round 一致(四舍五入, 不用 Python 的银行家舍入)"""
    return int(math.floor(v + 0.5))


def _runs(mask):
    """布尔序列 -> 连续 True 区段 [(start, end)]"""
    out, start = [], None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(mask) - 1))
    return out


def _median(vals):
    v = sorted(vals)
    m = len(v) // 2
    return v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2.0


# ---------------------------------------------------------------- 颜色空间

def rgb2lab(rgb):
    """sRGB -> CIELAB(D65)"""
    def f(v):
        v = v / 255.0
        return ((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92

    r, g, b = f(rgb[0]), f(rgb[1]), f(rgb[2])
    X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    Y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.0
    Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883

    def k(t):
        return math.cbrt(t) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = k(X), k(Y), k(Z)
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]


def delta_e(a, b):
    """ΔE76: Lab 空间欧氏距离"""
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)


# ---------------------------------------------------------------- 1. 定位棋盘

def _pick_series(bands):
    """从若干条带中挑出等间距、等宽度的最长连续序列(滤掉 UI 干扰)"""
    if not bands:
        return []
    widths = sorted(b[1] - b[0] + 1 for b in bands)
    med_w = _median(widths)
    best = []
    for i in range(len(bands)):
        series = [bands[i]]
        for j in range(i + 1, len(bands)):
            p0 = series[-1][0] - series[0][0]
            pitch = p0 / (len(series) - 1) if len(series) > 1 else None
            gap = bands[j][0] - series[-1][0]
            w = bands[j][1] - bands[j][0] + 1
            ok_w = 0.6 * med_w <= w <= 1.5 * med_w
            ok_p = pitch is None or abs(gap - pitch) <= 0.25 * pitch
            if ok_w and ok_p:
                series.append(bands[j])
            elif pitch is not None and gap > 1.6 * pitch:
                break
        if len(series) > len(best):
            best = series
    return best


def _bands(counts, thresh):
    return [b for b in _runs(counts > thresh) if b[1] - b[0] >= MIN_BAND]


def _longest_run(arr, thresh):
    """最长的一段连续超阈值区间 -> (start, end) 或 None"""
    best, start = None, None
    for i in range(len(arr) + 1):
        on = i < len(arr) and arr[i] > thresh
        if on and start is None:
            start = i
        elif not on and start is not None:
            if best is None or i - start > best[1] - best[0] + 1:
                best = (start, i - 1)
            start = None
    return best


def _color_stats(a):
    """彩色掩码 + 行/列投影(两种定位策略共用)"""
    sat = (a.max(axis=2) - a.min(axis=2)).astype(float)
    colored = sat > SAT_MIN
    rowcnt = colored.sum(axis=1).astype(float)
    colcnt = colored.sum(axis=0).astype(float)
    rowsat = sat.mean(axis=1)
    colsat = sat.mean(axis=0)
    return colored, rowcnt, colcnt, rowsat, colsat


def _extent_around_longest_run(arr, thresh):
    """
    棋盘外框: 在"最长的一段超阈值区间"基础上, 把缝隙很小(<= 段长 10%)的相邻区间也并进来。
    只取最长连续段会被个别偏低的像素行截断(例如某行刚好是浅色格子);
    直接取 min/max 又会把界面上的元素并进来。
    """
    idx = [i for i, v in enumerate(arr) if v > thresh]
    if not idx:
        return None
    longest = _longest_run(arr, thresh) or (idx[0], idx[-1])
    max_gap = max(3, _round((longest[1] - longest[0] + 1) * 0.1))
    lo, hi = longest
    # 向下扩展: idx 升序, 所以倒着扫; 缝隙一旦超过 max_gap 就停(再往前只会更远)
    for v in reversed(idx):
        if v >= lo:
            continue
        if lo - v <= max_gap:
            lo = v
        else:
            break
    # 向上扩展
    for v in idx:
        if v <= hi:
            continue
        if v - hi <= max_gap:
            hi = v
        else:
            break
    return (lo, hi)


def _detect_by_gaps(a, stats):
    """
    策略 A(常规): 饱和度间隙法。
    正面完整截图里格子之间有可见缝隙(低饱和), 投影会周期性地掉下来, 于是能精确切出每一格。
    缺点: 截图被缩小/压缩后缝隙被糊平就会失效。
    """
    colored, rowcnt = stats[0], stats[1]
    max_row = rowcnt.max()
    for frac in (0.45, 0.35, 0.55, 0.30, 0.60):
        rows = _pick_series(_bands(rowcnt, max_row * frac))
        if len(rows) < 3:
            continue
        y0, y1 = rows[0][0], rows[-1][1]
        colcnt = colored[y0:y1 + 1].sum(axis=0).astype(float)
        cols = _pick_series(_bands(colcnt, colcnt.max() * frac))
        if len(cols) != len(rows):
            continue
        return rows, cols
    return None


def _estimate_pitch(sig):
    """
    自相关估格子边长: 格子之间的缝更亮/更淡, 所以亮度、饱和度曲线都是周期信号。
    取"自相关接近最强"里**最小**的周期, 即基频 —— 否则容易锁到 2 倍周期(把 n 估成一半)。
    """
    n = len(sig)
    s = sig - float(sig.mean())
    lo = max(3, n // 30)                     # 最多 30 格
    hi = max(lo + 1, n // 3)                 # 至少 3 格
    acs = []
    for lag in range(lo, hi + 1):
        x, y = s[:n - lag], s[lag:]
        denom = math.sqrt(float(x @ x) * float(y @ y) + 1e-9)
        acs.append((lag, float(x @ y) / denom))
    if not acs:
        return None
    max_ac = max(ac for _, ac in acs)
    pick = None
    for lag, ac in acs:
        if ac >= 0.85 * max_ac and (pick is None or lag < pick[0]):
            pick = (lag, ac)
    if pick is None:
        return None
    return {"lag": pick[0], "ac": pick[1], "n_est": n / float(pick[0])}


def _even_bands(start, size, n):
    """把 [start, start+size) 均匀切成 n 段"""
    out = []
    for i in range(n):
        a0 = start + _round(i * size / n)
        a1 = start + _round((i + 1) * size / n) - 1
        out.append((a0, max(a0, a1)))
    return out


def _board_extent_by_blob(a, stats):
    """
    棋盘外框(稳): 彩色像素稠密区域的最大连通块。
    先把彩色掩码按 step 下采样(块内任一像素为彩色即算彩色), 再膨胀 DIL 格让格子缝不再阻断连通,
    取最大连通块; 最后只在块范围内用 25% 阈值求像素级精确边界。
    好处: 浅色格子造成的投影低谷、以及远离棋盘的界面元素都不会干扰。
    """
    colored = stats[0]
    height, width = colored.shape
    step = max(2, _round(min(width, height) / 120))
    gw, gh = -(-width // step), -(-height // step)
    grid = np.zeros((gh, gw), dtype=bool)
    ys, xs = np.nonzero(colored)
    grid[ys // step, xs // step] = True

    DIL = 2
    dil = np.zeros((gh, gw), dtype=bool)
    gy, gx = np.nonzero(grid)
    for dy in range(-DIL, DIL + 1):
        for dx in range(-DIL, DIL + 1):
            ny, nx = gy + dy, gx + dx
            ok = (ny >= 0) & (ny < gh) & (nx >= 0) & (nx < gw)
            dil[ny[ok], nx[ok]] = True

    # 最大 4 连通块(标签法)
    seen = np.zeros((gh, gw), dtype=bool)
    best = None
    for sy in range(gh):
        for sx in range(gw):
            if not dil[sy, sx] or seen[sy, sx]:
                continue
            stack = [(sy, sx)]
            seen[sy, sx] = True
            count = 0
            mnx = mxx = sx
            mny = mxy = sy
            while stack:
                cy, cx = stack.pop()
                count += 1
                if cx < mnx:
                    mnx = cx
                if cx > mxx:
                    mxx = cx
                if cy < mny:
                    mny = cy
                if cy > mxy:
                    mxy = cy
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < gh and 0 <= nx < gw and dil[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if best is None or count > best[0]:
                best = (count, mnx, mxx, mny, mxy)
    if best is None:
        return None

    _, mnx, mxx, mny, mxy = best
    yA, yB = mny * step, min(height - 1, (mxy + 1) * step - 1)
    xA, xB = mnx * step, min(width - 1, (mxx + 1) * step - 1)
    if yB - yA < 20 or xB - xA < 20:
        return None
    sub = colored[yA:yB + 1, xA:xB + 1]
    rowcnt = sub.sum(axis=1).astype(float)
    colcnt = sub.sum(axis=0).astype(float)
    y_r = _extent_around_longest_run(rowcnt, rowcnt.max() * 0.25)
    x_r = _extent_around_longest_run(colcnt, colcnt.max() * 0.25)
    if y_r is None or x_r is None:
        return None
    return {"x0": xA + x_r[0], "x1": xA + x_r[1], "y0": yA + y_r[0], "y1": yA + y_r[1]}


def _pitch_candidates(a, stats, ext):
    """在给定外框内, 用两个轴、两种信号的自相关估计格子边长, 返回候选 n(按可信度排序)"""
    rowsat, colsat = stats[3], stats[4]
    x0, x1, y0, y1 = ext["x0"], ext["x1"], ext["y0"], ext["y1"]
    h, w = y1 - y0 + 1, x1 - x0 + 1
    if h < 100 or w < 100:                  # 太小不可能是棋盘
        return []

    block = a[y0:y1 + 1, x0:x1 + 1].astype(float)
    row_lum = block.mean(axis=2).mean(axis=1)
    col_lum = block.mean(axis=2).mean(axis=0)
    row_sat = rowsat[y0:y1 + 1]
    col_sat = colsat[x0:x1 + 1]

    by_n = {}

    def _add(v, conf):
        v = _round(v)
        if 3 <= v <= 30 and (v not in by_n or by_n[v] < conf):
            by_n[v] = conf

    for sig, size in ((row_sat, h), (col_sat, w), (row_lum, h), (col_lum, w)):
        p = _estimate_pitch(sig)
        if p is None:
            continue
        est = size / float(p["lag"])
        _add(est, p["ac"])
        # 估算不确定时补上邻近的 n
        if abs(est - _round(est)) > 0.2:
            _add(est - 0.5, p["ac"] * 0.9)
            _add(est + 0.5, p["ac"] * 0.9)

    return sorted(by_n.items(), key=lambda kv: -kv[1])[:4]


def _detect_by_pitch(a, stats):
    """
    策略 B(兜底): 周期法。
    先定位棋盘外框, 再用亮度/饱和度曲线的自相关估计格子边长, 最后按 n 均匀切分。
    适合被缩小/压缩、缝隙已糊平的截图。
    外框给两种候选: 最大彩色连通块(稳)与投影阈值法(快), 让求解循环依次尝试。
    """
    rowcnt, colcnt = stats[1], stats[2]
    exts = []
    blob = _board_extent_by_blob(a, stats)
    if blob is not None:
        exts.append(blob)
    y_run = _extent_around_longest_run(rowcnt, rowcnt.max() * 0.5)
    x_run = _extent_around_longest_run(colcnt, colcnt.max() * 0.5)
    if y_run is not None and x_run is not None:
        e = {"x0": x_run[0], "x1": x_run[1], "y0": y_run[0], "y1": y_run[1]}
        if blob is None or e != blob:
            exts.append(e)

    out = []
    for ext in exts:
        h = ext["y1"] - ext["y0"] + 1
        w = ext["x1"] - ext["x0"] + 1
        for v, _ in _pitch_candidates(a, stats, ext):
            out.append((_even_bands(ext["y0"], h, v), _even_bands(ext["x0"], w, v)))
    return out


def _detect_hypotheses(a):
    """所有可行的棋盘切分方式(按优先级): 先常规格线法, 再周期法兜底"""
    stats = _color_stats(a)
    out = []
    gaps = _detect_by_gaps(a, stats)
    if gaps:
        out.append((gaps[0], gaps[1], "格线"))
    for rows, cols in _detect_by_pitch(a, stats):
        out.append((rows, cols, "周期"))
    return out, stats


def _detect_n(a):
    """找出棋盘的行列条带(兼容接口: 返回优先级最高的一种切分)。a 为 HxWx3 数组。"""
    hyps, _ = _detect_hypotheses(a)
    if not hyps:
        raise RuntimeError("未能识别出棋盘格子, 请确认截图包含完整的 n*n 网格")
    rows, cols, _ = hyps[0]
    if len(rows) != len(cols):
        raise RuntimeError("行列数不一致: %d 行 x %d 列" % (len(rows), len(cols)))
    return rows, cols


# ---------------------------------------------------------------- 2. 多点采样投票

def _sample_cell(a, width, cx0, ry0, cx1, ry1):
    """
    一格取 5 个小块, 各自求中位数颜色, 再用 ΔE 投票选出"共识色"。
    返回 dict(rgb, lab, consistency) —— consistency 为共识度(0~1)。
    """
    cell_w = cx1 - cx0 + 1
    cell_h = ry1 - ry0 + 1
    ccx = (cx0 + cx1) / 2.0
    ccy = (ry0 + ry1) / 2.0

    rgbs, labs = [], []
    for ox, oy, side in SAMPLE_OFFSETS:
        w = max(3, _round(cell_w * side))
        h = max(3, _round(cell_h * side))
        px = _round(ccx + ox * cell_w)
        py = _round(ccy + oy * cell_h)
        x0, y0 = px - w // 2, py - h // 2
        x1, y1 = x0 + w - 1, y0 + h - 1
        if x0 < cx0:
            x0 = cx0
            x1 = min(cx1, x0 + w - 1)
        if y0 < ry0:
            y0 = ry0
            y1 = min(ry1, y0 + h - 1)
        if x1 > cx1:
            x1 = cx1
            x0 = max(cx0, x1 - w + 1)
        if y1 > ry1:
            y1 = ry1
            y0 = max(ry0, y1 - h + 1)

        step = max(1, _round(min(w, h) / 12))       # 抽样步长, 控制耗时
        patch = a[y0:y1 + 1:step, x0:x1 + 1:step].reshape(-1, 3)
        rgb = [_median(patch[:, ch]) for ch in range(3)]
        rgbs.append(rgb)
        labs.append(rgb2lab(rgb))

    best_i, best_support = 0, -1
    for i in range(len(labs)):
        support = sum(1 for j in range(len(labs)) if delta_e(labs[i], labs[j]) <= VOTE_DELTA_E)
        if support > best_support:
            best_support, best_i = support, i
    return {"rgb": rgbs[best_i], "lab": labs[best_i],
            "consistency": best_support / float(len(labs)), "samples": rgbs}


# ---------------------------------------------------------------- 3. 颜色聚类

def _mean_lab(labs, members):
    n = len(members)
    return [sum(labs[m][t] for m in members) / n for t in range(3)]


def _stats_of(assign, labs):
    """划分 -> [{id, members, mean}] (按 id 升序)"""
    ids = sorted(set(assign))
    return [{"id": i,
             "members": [k for k, v in enumerate(assign) if v == i],
             "mean": _mean_lab(labs, [k for k, v in enumerate(assign) if v == i])}
            for i in ids]


def _compact(assign):
    """去掉空簇并重编号, 使 id 落在 0..k-1"""
    ids = sorted(set(assign))
    mapping = {v: i for i, v in enumerate(ids)}
    return [mapping[v] for v in assign]


def _cluster_once(labs, tol):
    """单次聚类: 贪心生长 + 最多两轮"重分配到最近簇" """
    clusters = []            # [mean, members]
    assign = [0] * len(labs)
    for i, lab in enumerate(labs):
        hit = -1
        for k, (mean, _) in enumerate(clusters):
            if delta_e(lab, mean) <= tol:
                hit = k
                break
        if hit < 0:
            clusters.append([list(lab), [i]])
            hit = len(clusters) - 1
        else:
            clusters[hit][1].append(i)
            clusters[hit][0] = _mean_lab(labs, clusters[hit][1])
        assign[i] = hit

    for _ in range(2):
        changed = False
        for i in range(len(labs)):
            best_k, best_d = 0, float("inf")
            for k, (mean, _) in enumerate(clusters):
                d = delta_e(labs[i], mean)
                if d < best_d:
                    best_d, best_k = d, k
            if best_k != assign[i]:
                clusters[assign[i]][1].remove(i)
                clusters[best_k][1].append(i)
                assign[i] = best_k
                changed = True
        for cl in clusters:
            if cl[1]:
                cl[0] = _mean_lab(labs, cl[1])
        if not changed:
            break
    a = _compact(assign)
    return a, len(set(a))


def _repair_to(assign, labs, n):
    """把簇数修到正好 n: 多了合并最相近的, 少了拆开最分散的"""
    a = _compact(assign)
    guard = 0
    while len(set(a)) != n and guard <= len(a) + n:
        guard += 1
        stats = _stats_of(a, labs)
        k = len(stats)
        if k > n:
            bi, bj, bd = 0, 1, float("inf")
            for i in range(k):
                for j in range(i + 1, k):
                    d = delta_e(stats[i]["mean"], stats[j]["mean"])
                    if d < bd:
                        bd, bi, bj = d, i, j
            src, dst = stats[bj]["id"], stats[bi]["id"]
            a = _compact([dst if v == src else v for v in a])
        else:
            # 拆开内部最分散的簇: 以"离均值最远的点"和"离它最远的点"为种子做 2-means
            pick, pick_spread = stats[0], -1.0
            for st in stats:
                spread = max(delta_e(labs[m], st["mean"]) for m in st["members"])
                if spread > pick_spread:
                    pick_spread, pick = spread, st
            members = pick["members"]
            p1 = max(members, key=lambda m: delta_e(labs[m], pick["mean"]))
            p2 = max(members, key=lambda m: delta_e(labs[m], labs[p1]))
            c1, c2 = list(labs[p1]), list(labs[p2])
            side = {}
            for _ in range(6):
                g1, g2 = [], []
                for m in members:
                    if delta_e(labs[m], c1) <= delta_e(labs[m], c2):
                        g1.append(m)
                        side[m] = 0
                    else:
                        g2.append(m)
                        side[m] = 1
                if not g1 or not g2:
                    break
                c1, c2 = _mean_lab(labs, g1), _mean_lab(labs, g2)
            new_id = max(a) + 1
            a = _compact([new_id if (v == pick["id"] and side.get(i) == 1) else v
                          for i, v in enumerate(a)])
    return a if len(set(a)) == n else None


def _quality(assign, labs, consistency):
    """
    划分质量: 轮廓系数式评分, 再乘以采样共识度, 越大越好(约 -1 ~ 1)。
    对每个簇算 a=簇内平均距离、b=到最近邻簇的平均距离, 取 (b-a)/max(a,b) 求平均。
    """
    stats = _stats_of(assign, labs)
    total = 0.0
    for st in stats:
        members = st["members"]
        a = sum(delta_e(labs[m], st["mean"]) for m in members) / len(members)
        b = float("inf")
        for other in stats:
            if other is st:
                continue
            d = sum(delta_e(labs[m], other["mean"]) for m in members) / len(members)
            if d < b:
                b = d
        if not math.isfinite(b):
            b = a
        total += (b - a) / max(a, b, 1e-6)
    sil = total / len(stats)
    cons = sum(consistency) / len(consistency) if consistency else 1.0
    return (sil + 1) * (0.5 + 0.5 * cons)


def _cluster_candidates(labs, n, consistency):
    """产生候选划分: 每个容差一种, 去重后按质量从高到低排序(同分优先未经修复的)"""
    out = {}
    for tol in LAB_TOLS:
        assign = _cluster_once(labs, tol)[0]
        repaired = False
        if len(set(assign)) != n:
            fixed = _repair_to(assign, labs, n)
            if fixed is None:
                continue
            assign, repaired = fixed, True
        sig = tuple(assign)
        if sig in out:
            if not repaired:
                out[sig]["repaired"] = False
            continue
        out[sig] = {"assign": assign, "repaired": repaired,
                    "score": round(_quality(assign, labs, consistency), 6)}
    return sorted(out.values(), key=lambda c: (-c["score"], c["repaired"]))


# ---------------------------------------------------------------- 连通性

def _connected(regions, n, key):
    """检查编号 key 的区域是否四连通, 返回(最大连通块掩码, 连通块数量)"""
    mask = np.zeros((n, n), dtype=bool)
    seen = np.zeros((n, n), dtype=bool)
    grid = regions.reshape(n, n)
    comps = []
    for r in range(n):
        for c in range(n):
            if grid[r, c] != key or seen[r, c]:
                continue
            stack, cur = [(r, c)], []
            seen[r, c] = True
            while stack:
                y, x = stack.pop()
                cur.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < n and 0 <= nx < n and grid[ny, nx] == key and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            comps.append(cur)
    if not comps:
        return mask, 0
    comps.sort(key=len, reverse=True)
    for y, x in comps[0]:
        mask[y, x] = True
    return mask, len(comps)


def _regions_from(assign, n, warnings):
    """划分 -> 区域网格; 若某种颜色不连通(游戏里不会发生)则该划分作废, 返回 None"""
    regions = np.array(assign, dtype=int)
    for key in range(n):
        mask, ncomp = _connected(regions, n, key)
        if ncomp != 1:
            warnings.append("颜色 %d 被划成了 %d 块, 该划分作废" % (key + 1, ncomp))
            return None
    return regions


# ---------------------------------------------------------------- 4. 求解

def solve(n, regions, limit=50):
    """
    位掩码 + 前向检查 + 回溯(最小剩余值), 返回找到的解(最多 limit 个)

    规则: 每种颜色 1 只猫、每行每列 1 只猫、任意两只猫八邻不相邻。
    关键: 猫只占所在颜色区域里的一格, 冲突只按"该格子的邻居"计算,
          不能按整个颜色区域的邻居并集来算(那是过度约束, 会把有解判成无解)。

    前向检查: 每放一只猫, 立刻把被禁格子从其它颜色的候选集中剔除并检查空域,
              空域立即回退, 比每层临时统计更早剪枝。
    """
    regs = sorted(int(x) for x in np.unique(regions) if x >= 0)
    idx = lambda r, c: r * n + c

    cand = {k: 0 for k in regs}
    for i in range(n * n):
        k = int(regions[i])
        if k >= 0:
            cand[k] |= 1 << i

    nbr = [0] * (n * n)
    for r in range(n):
        for c in range(n):
            m = 0
            for dy, dx in DIRS8:
                ny, nx = r + dy, c + dx
                if 0 <= ny < n and 0 <= nx < n:
                    m |= 1 << idx(ny, nx)
            nbr[idx(r, c)] = m

    rowmask = [sum(1 << idx(r, c) for c in range(n)) for r in range(n)]
    colmask = [sum(1 << idx(r, c) for r in range(n)) for c in range(n)]

    solutions = []
    placed = []
    avail = dict(cand)                     # 每个颜色当前的候选格(前向检查维护)

    def rec(remaining):
        if not remaining:
            solutions.append(list(placed))
            return len(solutions) >= limit
        # 最小剩余值: 先处理候选最少的颜色
        best_k, best_cnt = None, None
        for k in remaining:
            cnt = bin(avail[k]).count("1")
            if cnt == 0:
                return False
            if best_cnt is None or cnt < best_cnt:
                best_k, best_cnt = k, cnt

        rest = [k for k in remaining if k != best_k]
        saved = [avail[k] for k in rest]
        m = avail[best_k]
        while m:
            low = m & -m
            m ^= low
            p = low.bit_length() - 1
            r, c = divmod(p, n)
            removed = low | nbr[p] | rowmask[r] | colmask[c]

            # ---- 前向检查: 把这一格的自身/邻居/整行/整列从其它候选里剔除 ----
            ok = True
            for k in rest:
                na = avail[k] & ~removed
                avail[k] = na
                if na == 0:
                    ok = False
            if ok:
                placed.append((r, c))
                if rec(rest):
                    return True
                placed.pop()
            for k, sv in zip(rest, saved):
                avail[k] = sv
        return False

    rec(set(regs))
    return solutions


def validate(n, regions, cells):
    """用独立逻辑校验解是否符合三条规则"""
    rs = sorted(r for r, _ in cells)
    cs = sorted(c for _, c in cells)
    assert rs == list(range(n)), "行约束不满足"
    assert cs == list(range(n)), "列约束不满足"
    assert len({int(regions[r * n + c]) for r, c in cells}) == n, "颜色约束不满足"
    cellset = set(cells)
    for r, c in cells:
        for dy, dx in DIRS8:
            ny, nx = r + dy, c + dx
            if 0 <= ny < n and 0 <= nx < n:
                assert (ny, nx) not in cellset, "两只猫相邻: (%d,%d)-(%d,%d)" % (r, c, ny, nx)


# ---------------------------------------------------------------- 5. 完整流程

def _try_hypothesis(a, width, rows, cols, method):
    """
    用一种棋盘切分方式尝试求解(采样 -> 候选划分 -> 自愈回路 -> 校验)。
    返回 (结果 dict 或 None, 尝试过的颜色划分数量)
    """
    n = len(rows)
    warnings = []

    # 多点采样投票
    samples, boxes = [], []
    for (ry0, ry1) in rows:
        for (cx0, cx1) in cols:
            samples.append(_sample_cell(a, width, cx0, ry0, cx1, ry1))
            boxes.append((cx0, ry0, cx1, ry1))
    consistency = [s["consistency"] for s in samples]
    low_n = sum(1 for c in consistency if c < LOW_CONSISTENCY)
    if low_n:
        warnings.append("%d 个格子采样不一致, 识别可能不稳" % low_n)
    labs = [s["lab"] for s in samples]

    bx0 = min(b[0] for b in boxes)
    by0 = min(b[1] for b in boxes)
    bx1 = max(b[2] for b in boxes)
    by1 = max(b[3] for b in boxes)

    # 候选划分(自愈回路的基础)
    candidates = _cluster_candidates(labs, n, consistency)
    if not candidates:
        return None, 0

    # 自愈回路: 按质量依次尝试每种划分, 解不出就换下一种
    for i, cand in enumerate(candidates):
        w = []
        regions = _regions_from(cand["assign"], n, w)
        if regions is None:
            continue
        solutions = solve(n, regions, limit=50)
        if not solutions:
            continue

        cells = solutions[0]
        validate(n, regions, cells)
        if i > 0:
            warnings.append("前 %d 种颜色划分无解, 已自动改用第 %d 种" % (i, i + 1))
        if cand["repaired"]:
            warnings.append("颜色划分经过自动合并/拆分修正")
        warnings.extend(w)
        coords = sorted(((c + 1, n - r) for r, c in cells), key=lambda t: t[0])
        return {"n": n, "cells": cells, "coords": coords, "regions": regions,
                "boxes": boxes, "board": (bx0, by0, bx1, by1), "warnings": warnings,
                "unique": len(solutions) == 1, "solution_count": len(solutions),
                "attempts": i + 1, "repaired": bool(cand["repaired"]),
                "method": method}, len(candidates)

    return None, len(candidates)


def analyze(path):
    """
    截图 -> 结果。两层自愈:
      1) 棋盘定位: 先用"格线法"精确切格; 不行再退回"周期法"(自相关估格子边长后均匀切分)
      2) 颜色划分: 每种容差一种划分, 按轮廓系数排序后依次尝试, 不连通或无解就换下一种
    """
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    width = a.shape[1]
    stats = _color_stats(a)

    tried, cand_total = [], 0

    def _run(hypotheses):
        nonlocal cand_total
        for rows, cols, method in hypotheses:
            res, ncand = _try_hypothesis(a, width, rows, cols, method)
            cand_total += ncand
            if res is not None:
                return res
            tried.append("%s n=%d" % (method, len(rows)))
        return None

    # 先试常规格线法; 它失败才动用周期法
    gaps = _detect_by_gaps(a, stats)
    res = _run([(gaps[0], gaps[1], "格线")]) if gaps else None

    if res is None:
        pitch = [(rows, cols, "周期") for rows, cols in _detect_by_pitch(a, stats)]
        res = _run(pitch)
        if res is not None:
            res["warnings"].insert(
                0, "常规格线识别不适用, 已改用周期法按 n=%d 均匀切分" % res["n"])

    if res is None:
        if not tried:
            raise RuntimeError("未能识别出棋盘格子, 请确认截图包含完整的 n*n 网格")
        what = "、".join(tried)
        raise RuntimeError("无解: 已尝试 %d 种棋盘切分方式(%s)、共 %d 种颜色划分仍未找到答案, "
                           "请换一张清晰完整的截图" % (len(tried), what, cand_total))
    return res


# ---------------------------------------------------------------- 输出

def main():
    ap = argparse.ArgumentParser(description="Catspotter — 从游戏截图找出所有猫的位置")
    ap.add_argument("image", help="游戏截图路径")
    ap.add_argument("--mark", nargs="?", const="", default=None, metavar="OUT.png",
                    help="保存标注了猫坐标的图片; 不带参数时自动保存为与截图同名的 .png")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    args = ap.parse_args()

    try:
        res = analyze(args.image)
    except (RuntimeError, OSError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)

    n = res["n"]
    cells = res["cells"]
    coords = res["coords"]
    unique = "唯一解" if res["unique"] else \
        "共 %d 个符合规则的解(最多统计 50 个), 输出第一个" % res["solution_count"]

    if args.json:
        print(json.dumps({"n": n, "unique": res["unique"],
                          "attempts": res["attempts"],
                          "method": res["method"],
                          "coords": [{"x": x, "y": y} for x, y in coords]},
                         ensure_ascii=False))
    else:
        print("棋盘: %d x %d   (%s)" % (n, n, unique))
        print("小猫坐标 (x=列, y=行):")
        print("  " + "  ".join("(%d,%d)" % (x, y) for x, y in coords))
        print("逐只:")
        for i, (x, y) in enumerate(coords, 1):
            print("  第%2d只: 列%2d 行%2d  ->  (%d, %d)" % (i, x, y, x, y))
    for w in res["warnings"]:
        print("[提示] %s" % w, file=sys.stderr)

    if args.mark is not None:
        out = args.mark or os.path.splitext(args.image)[0] + ".png"
        if os.path.abspath(out).lower() == os.path.abspath(args.image).lower():
            out = os.path.splitext(args.image)[0] + "_marked.png"   # 不覆盖原截图
        im = Image.open(args.image).convert("RGB")
        d = ImageDraw.Draw(im)
        for r, c in cells:
            x0, y0, x1, y1 = res["boxes"][r * n + c]
            d.ellipse([x0 - 6, y0 - 6, x1 + 6, y1 + 6], outline=(255, 0, 0), width=8)
        im.save(out)
        print("已保存标注图: %s" % out, file=sys.stderr)


if __name__ == "__main__":
    main()
