# -*- coding: utf-8 -*-
"""
n-times-n 找猫求解器
====================
输入: 一张游戏截图(n*n 纯色格子, 每种颜色连成一片)
输出: n 只小猫的坐标 (列, 行), 与游戏内坐标一致(左下角为 (1,1))

游戏规则:
  1. 每种颜色仅有 1 只猫
  2. 每行每列仅有 1 只猫
  3. 任意两只猫不能相邻 —— 上下左右和对角线都不行(八邻);
     中间格子周围 8 格都不能有猫, 贴边 5 格, 贴角 3 格

用法:
  python solver.py 截图.jpg            # 打印坐标
  python solver.py 截图.jpg --mark     # 另存标注结果图, 自动命名为同名 .png
  python solver.py 截图.jpg --mark out.png  # 另存到指定路径
  python solver.py 截图.jpg --json     # 输出 JSON
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw


# ---------------------------------------------------------------- 图像识别

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


def _pick_series(bands):
    """从若干条带中挑出等间距、等宽度的最长连续序列(滤掉 UI 干扰)"""
    if not bands:
        return []
    widths = np.array([b[1] - b[0] + 1 for b in bands], dtype=float)
    med_w = float(np.median(widths))
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
    return [b for b in _runs(counts > thresh) if b[1] - b[0] >= 12]


def _detect_n(a):
    """找出棋盘的 n 与行列条带。先用饱和度找彩色区, 再用边缘剖面求格线。"""
    sat = (a.max(axis=2) - a.min(axis=2))
    colored = sat > 35                      # 棋盘格子与彩色文字均为"有色"
    rowcnt = colored.sum(axis=1)

    best = None
    for frac in (0.45, 0.35, 0.55, 0.30, 0.60):
        rows = _pick_series(_bands(rowcnt, rowcnt.max() * frac))
        if not rows:
            continue
        sub = colored[rows[0][0]:rows[-1][1] + 1]
        colcnt = sub.sum(axis=0)
        cols = _pick_series(_bands(colcnt, colcnt.max() * frac))
        if not cols:
            continue
        if len(rows) == len(cols):
            best = (rows, cols)
            break
    if best is None:
        raise RuntimeError("未能识别出棋盘格子, 请确认截图包含完整的 n*n 网格")
    rows, cols = best
    if len(rows) != len(cols):
        raise RuntimeError("行列数不一致: %d 行 x %d 列" % (len(rows), len(cols)))
    return rows, cols


def _cluster(colors, tol=34):
    """把采样颜色聚成 n 类(贪心 + 两轮重分配)"""
    clusters = []                            # [mean_rgb, [member_idx]]
    assign = [None] * len(colors)
    for i, c in enumerate(colors):
        hit = None
        for k, (mean, _) in enumerate(clusters):
            if max(abs(int(mean[t]) - int(c[t])) for t in range(3)) <= tol:
                hit = k
                break
        if hit is None:
            clusters.append([np.array(c, dtype=float), [i]])
            hit = len(clusters) - 1
        else:
            members = clusters[hit][1]
            members.append(i)
            clusters[hit][0] = np.mean([colors[m] for m in members], axis=0)
        assign[i] = hit

    for _ in range(2):                       # 重分配到最近的簇
        changed = False
        for i, c in enumerate(colors):
            k = int(np.argmin([np.abs(clusters[k][0] - c).max() for k in range(len(clusters))]))
            if k != assign[i]:
                for k2, (mean, members) in enumerate(clusters):
                    if i in members:
                        members.remove(i)
                clusters[k][1].append(i)
                assign[i] = k
                changed = True
        for k in range(len(clusters)):
            if clusters[k][1]:
                clusters[k][0] = np.mean([colors[m] for m in clusters[k][1]], axis=0)
        if not changed:
            break
    return assign, len(clusters)


def _cluster_auto(colors, n):
    """自动搜索颜色容差, 使聚类数正好等于 n"""
    best = None
    for tol in (30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 9, 8, 7, 6, 5, 4):
        assign, k = _cluster(colors, tol)
        if k == n:
            return assign, k
        if best is None or abs(k - n) < abs(best[1] - n):
            best = (assign, k)
    print("[警告] 自动容差仍未聚成 %d 种颜色" % n, file=sys.stderr)
    return best


def _connected(grid, k):
    """检查编号 k 的区域是否四连通; 否则返回其最大连通块的掩码"""
    g = (grid == k)
    h, w = g.shape
    seen = np.zeros_like(g)
    comps = []
    for r in range(h):
        for c in range(w):
            if g[r, c] and not seen[r, c]:
                stack, cur = [(r, c)], []
                seen[r, c] = True
                while stack:
                    y, x = stack.pop()
                    cur.append((y, x))
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and g[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
                comps.append(cur)
    comps.sort(key=len, reverse=True)
    mask = np.zeros_like(g)
    if not comps:
        return mask, 0
    for y, x in comps[0]:
        mask[y, x] = True
    return mask, len(comps)


def read_grid(path):
    """截图 -> (n, regions)  regions[r][c] 为颜色区域编号, r=0 是最上面一行"""
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    rows, cols = _detect_n(a)
    n = len(rows)

    colors = []
    boxes = []
    for (ry0, ry1) in rows:
        for (cx0, cx1) in cols:
            h = max(3, int((ry1 - ry0 + 1) * 0.35))
            w = max(3, int((cx1 - cx0 + 1) * 0.35))
            cy, cx = (ry0 + ry1) // 2, (cx0 + cx1) // 2
            patch = a[cy - h // 2:cy + h // 2 + 1, cx - w // 2:cx + w // 2 + 1]
            colors.append(np.median(patch.reshape(-1, 3), axis=0))
            boxes.append((cx0, ry0, cx1, ry1))

    assign, k = _cluster_auto(colors, n)
    if k != n:
        print("[警告] 颜色聚类数 %d != %d, 按 %d 处理(请检查截图)" % (k, n, n), file=sys.stderr)

    regions = np.array(assign, dtype=int).reshape(n, n)

    # 每种颜色必须连成一片(游戏设定), 只保留最大连通块
    for k in range(n):
        mask, ncomp = _connected(regions, k)
        if ncomp > 1:
            print("[警告] 颜色 %d 不连通(%d 块), 已取最大块" % (k + 1, ncomp), file=sys.stderr)
            regions[(regions == k) & ~mask] = -1
    return n, regions, boxes


# ---------------------------------------------------------------- 求解

def solve(n, regions, limit=50):
    """规则求解, 返回找到的解(最多 limit 个)

    规则:
      1) 每种颜色恰好 1 只猫
      2) 每行每列恰好 1 只猫
      3) 任意两只猫不能相邻 —— 上下左右与对角线都不行(八邻)

    关键: 猫只占它所在颜色区域里的**一格**, 因此冲突只按"该格子的邻居"计算,
    不能按整个颜色区域的邻居并集来算(那是过度约束, 会把有解判成无解)。
    """
    dirs = [(1, 0), (-1, 0), (0, 1), (0, -1),
            (1, 1), (1, -1), (-1, 1), (-1, -1)]

    regs = sorted(int(x) for x in np.unique(regions))
    idx = lambda r, c: r * n + c

    cand = {k: 0 for k in regs}                      # 每种颜色的候选格掩码
    for r in range(n):
        for c in range(n):
            cand[int(regions[r][c])] |= 1 << idx(r, c)

    nbr = [0] * (n * n)                              # 每个格子的邻居掩码
    for r in range(n):
        for c in range(n):
            m = 0
            for dy, dx in dirs:
                ny, nx = r + dy, c + dx
                if 0 <= ny < n and 0 <= nx < n:
                    m |= 1 << idx(ny, nx)
            nbr[idx(r, c)] = m

    rowmask = [sum(1 << idx(r, c) for c in range(n)) for r in range(n)]
    colmask = [sum(1 << idx(r, c) for r in range(n)) for c in range(n)]

    solutions = []
    state = {"forbid": 0, "row": 0, "col": 0, "placed": []}

    def rec(remaining):
        if not remaining:
            solutions.append(list(state["placed"]))
            return len(solutions) >= limit
        # 最小剩余值: 先处理候选格最少的颜色, 能大幅剪枝
        best, best_cnt = None, None
        for k in remaining:
            m = cand[k] & ~state["forbid"] & ~state["row"] & ~state["col"]
            cnt = bin(m).count("1")
            if best_cnt is None or cnt < best_cnt:
                best, best_cnt = k, cnt
                if cnt == 0:
                    break
        if best_cnt == 0:
            return False
        m = cand[best] & ~state["forbid"] & ~state["row"] & ~state["col"]
        rest = remaining - {best}
        while m:
            low = m & -m
            m ^= low
            p = low.bit_length() - 1
            r, c = divmod(p, n)
            saved = state["forbid"], state["row"], state["col"]
            state["forbid"] |= low | nbr[p]          # 只禁这一格的邻居
            state["row"] |= rowmask[r]
            state["col"] |= colmask[c]
            state["placed"].append((r, c))
            if rec(rest):
                return True
            state["placed"].pop()
            state["forbid"], state["row"], state["col"] = saved
        return False

    rec(set(regs))
    return solutions


def validate(n, regions, cells):
    """校验解是否符合三条规则"""
    rs = sorted(r for r, _ in cells)
    cs = sorted(c for _, c in cells)
    assert rs == list(range(n)), "行约束不满足"
    assert cs == list(range(n)), "列约束不满足"
    assert len({int(regions[r][c]) for r, c in cells}) == n, "颜色约束不满足"
    dirs = [(1, 0), (-1, 0), (0, 1), (0, -1),
            (1, 1), (1, -1), (-1, 1), (-1, -1)]
    for r, c in cells:
        for dy, dx in dirs:
            ny, nx = r + dy, c + dx
            if 0 <= ny < n and 0 <= nx < n:
                assert (ny, nx) not in cells, "两只猫相邻: (%d,%d)-(%d,%d)" % (r, c, ny, nx)


# ---------------------------------------------------------------- 输出

def main():
    ap = argparse.ArgumentParser(description="n-times-n 找猫求解器")
    ap.add_argument("image", help="游戏截图路径")
    ap.add_argument("--mark", nargs="?", const="", default=None, metavar="OUT.png",
                    help="保存标注了猫坐标的图片; 不带参数时自动保存为与截图同名的 .png")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    args = ap.parse_args()

    n, regions, boxes = read_grid(args.image)
    solutions = solve(n, regions, limit=50)
    if not solutions:
        print("无解, 请检查截图是否完整、颜色是否清晰", file=sys.stderr)
        sys.exit(2)

    cells = solutions[0]
    validate(n, regions, cells)
    unique = "唯一解" if len(solutions) == 1 else "共 %d 个符合规则的解(最多统计 50 个), 输出第一个" % len(solutions)

    # 转成游戏坐标: 列 x 自左向右, 行 y 自下而上, 左下角为 (1,1)
    coords = sorted(((c + 1, n - r) for r, c in cells), key=lambda t: t[0])

    if args.json:
        print(json.dumps({"n": n, "unique": len(solutions) == 1,
                          "coords": [{"x": x, "y": y} for x, y in coords]}, ensure_ascii=False))
    else:
        print("棋盘: %d x %d   (%s)" % (n, n, unique))
        print("小猫坐标 (x=列, y=行):")
        print("  " + "  ".join("(%d,%d)" % (x, y) for x, y in coords))
        print("逐只:")
        for i, (x, y) in enumerate(coords, 1):
            print("  第%2d只: 列%2d 行%2d  ->  (%d, %d)" % (i, x, y, x, y))

    if args.mark is not None:
        out = args.mark or os.path.splitext(args.image)[0] + ".png"
        if os.path.abspath(out).lower() == os.path.abspath(args.image).lower():
            out = os.path.splitext(args.image)[0] + "_marked.png"   # 不覆盖原截图
        im = Image.open(args.image).convert("RGB")
        d = ImageDraw.Draw(im)
        for r, c in cells:
            x0, y0, x1, y1 = boxes[r * n + c]
            d.ellipse([x0 - 6, y0 - 6, x1 + 6, y1 + 6], outline=(255, 0, 0), width=8)
        im.save(out)
        print("已保存标注图: %s" % out, file=sys.stderr)


if __name__ == "__main__":
    main()



