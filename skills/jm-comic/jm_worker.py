#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""jm-comic 技能的 Python 工作进程：竖切还原 + 合成 PDF。

只做两件事，不做网络请求（下载全在 Node 侧完成）：
  1. 按站点返回的 scramble_id 还原被竖切打乱的图片
  2. 把整本按章节/页码顺序合成一个 PDF

用法（stdin 收 JSON 参数，stdout 输出 JSON Lines 进度，最后一行是结果）：
    jm_worker.py --check          # 能力自检：{"ok":true,"pillow":"12.3.0",...}
    jm_worker.py --selftest       # 切块数(N)口径回归用例
    jm_worker.py                  # 读 stdin 的 JSON 任务执行

任务 JSON：
{
  "album_id": "422444",
  "title": "本子名",
  "scramble_id": 220980,
  "descramble": true,
  "output": "D:\\...\\JM422444-本子名.pdf",
  "quality": 85,
  "max_dim": 2000,          // 0 = 不缩放
  "chapters": [ { "name": "第1话", "pages": ["D:\\...\\00001.webp", ...] }, ... ]
}

输出协议（每行一个 JSON）：
    {"t":"progress","stage":"descramble","done":12,"total":300,"ok":12,"fail":3}
    {"t":"progress","stage":"pdf","done":1,"total":1}
    {"t":"result","ok":true,"output":"...","pages":300,"pagesOk":297,"restored":297,"bytes":12345678,"failed":[...],"warnings":[...]}
    {"t":"result","ok":false,"error":"..."}

为什么要独立进程：Node 侧没有图像库（项目里没有 sharp/jimp，也没有 ffmpeg.exe），
还原必须解码重编码；Pillow 是最稳的选择。本进程崩了也不会影响机器人主进程。
"""

import hashlib
import json
import math
import os
import sys
import traceback

# ── jm 竖切参数（与 jmcomic 的 JmMagicConstants 一致）──────────────────────────
SCRAMBLE_220980 = 220980
SCRAMBLE_268850 = 268850
SCRAMBLE_421926 = 421926

# 图片扩展名（JM 的 CDN 主要给 webp，也可能 jpg/png/gif）
IMAGE_EXTS = (".webp", ".jpg", ".jpeg", ".png", ".gif", ".bmp")


def emit(obj):
    """输出一行 JSON 并立即 flush —— Node 侧要实时看进度，不能等缓冲。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def md5hex(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def segmentation_num(scramble_id, album_id, filename):
    """切块数 N；N <= 0 表示无需还原。

    ⚠️⚠️ filename **必须是去掉扩展名的文件名**（如 '00001'，不是 '00001.webp'）！
    这是本技能最容易踩、且后果最严重的坑：jmcomic 侧走的是
        JmImageTool.get_num_by_url(scramble_id, img_url) → of_file_name(url, True) → '00001'
    而 of_file_name(url, True) 的第二个参数就是"去掉后缀"。用带扩展名的名字算出来的 N
    是另一个值（例如 JM1465595 第1页：去扩展名=4 正确，带扩展名=12 错误），
    结果是"还原"把本来正确的图重新弄花——实测踩过，逐像素比对才定位到。
    """
    try:
        scramble_id = int(scramble_id or 0)
        aid = int(album_id)
    except (TypeError, ValueError):
        return 0
    if scramble_id <= 0 or aid < scramble_id:
        return 0
    if aid < SCRAMBLE_268850:
        return 10
    x = 10 if aid < SCRAMBLE_421926 else 8
    stem = filename_stem(filename)
    last = md5hex(f"{aid}{stem}")[-1]
    return (ord(last) % x) * 2 + 2


def filename_stem(name):
    """取"去掉扩展名"的文件名（与 jmcomic 的 of_file_name(url, True) 等价）。"""
    import os
    return os.path.splitext(os.path.basename(str(name)))[0]


def descramble(img, num):
    """把被竖切的图还原：从下往上取第 i 条，放到从上往下第 i 个位置。"""
    if num <= 0:
        return img
    from PIL import Image

    w, h = img.size
    out = Image.new(img.mode, (w, h))
    over = h % num
    for i in range(num):
        move = math.floor(h / num)
        y_src = h - (move * (i + 1)) - over
        y_dst = move * i
        if i == 0:
            move += over
        else:
            y_dst += over
        out.paste(img.crop((0, y_src, w, y_src + move)), (0, y_dst, w, y_dst + move))
    return out


def run_check():
    try:
        import PIL
        from PIL import Image, features  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"Pillow 不可用：{exc}"})
        return 1
    emit({
        "ok": True,
        "pillow": getattr(PIL, "__version__", "?"),
        "webp": bool(features.check("webp")),
        "jpeg": bool(features.check("jpg")),
        "python": sys.version.split()[0],
    })
    return 0


# 切块数回归用例：(本子ID, 图片文件名, 期望 N)
# 这些值是用 jmcomic 官方 get_num 逐条核对过的（见 README「踩坑记录」）。
# ⚠️ 其中 1465595/00001.webp 是本次事故的本尊：带扩展名会算成 12，去扩展名才是 4。
NUM_CASES = [
    (1465595, "00001.webp", 4),
    (1465595, "00004.webp", 14),
    (422444, "00001.webp", 4),
    (29559, "00001.webp", 0),      # 低于阈值 → 不还原
    (300000, "00001.webp", 16),    # 268850..421926 区间 → x=10
    (500000, "00001.webp", 12),    # 421926 以上 → x=8
]


def run_selftest():
    """验证 segmentation_num 的输入口径（尤其是"必须去扩展名"）。"""
    bad = []
    for aid, name, expect in NUM_CASES:
        got = segmentation_num(SCRAMBLE_220980, aid, name)
        if got != expect:
            bad.append({"aid": aid, "file": name, "expect": expect, "got": got})
    stem_cases = [("00001.webp", "00001"), ("D:/a/00004.JPG", "00004"), ("00001", "00001")]
    for raw, expect in stem_cases:
        if filename_stem(raw) != expect:
            bad.append({"filename_stem": raw, "expect": expect, "got": filename_stem(raw)})
    emit({"ok": not bad, "cases": len(NUM_CASES) + len(stem_cases), "failed": bad})
    return 0 if not bad else 1


def run_task(task):
    from PIL import Image

    output = task.get("output") or ""
    quality = int(task.get("quality") or 85)
    quality = max(30, min(95, quality))
    max_dim = int(task.get("max_dim") or 0)
    scramble_id = task.get("scramble_id") or 0
    album_id = str(task.get("album_id") or "0")
    do_descramble = task.get("descramble") is not False
    chapters = task.get("chapters") or []

    # 图片的 mode 必须是 RGB 才能进 PDF；RGBA/P 等一律转 RGB
    def to_rgb(im):
        if im.mode in ("RGB", "L"):
            return im if im.mode == "RGB" else im.convert("RGB")
        if im.mode == "P" and "transparency" in im.info:
            return im.convert("RGBA").convert("RGB")
        return im.convert("RGB")

    all_pages = [(ch.get("name") or "", p) for ch in chapters for p in (ch.get("pages") or [])]
    total = len(all_pages)
    if total == 0:
        emit({"t": "result", "ok": False, "error": "没有可处理的图片（下载阶段就没有落盘）"})
        return 1

    emit({"t": "progress", "stage": "descramble", "done": 0, "total": total, "ok": 0, "fail": 0})

    frames = []
    failed = []
    warnings = []
    restored = 0
    ok_count = 0
    done = 0

    for _chapter_name, path in all_pages:
        done += 1
        try:
            if not os.path.isfile(path):
                raise FileNotFoundError(path)
            if os.path.getsize(path) <= 512:
                raise ValueError("文件过小，可能下载不完整")
            with Image.open(path) as img:
                img.load()
                frames.append(_prepare(img, path, do_descramble, scramble_id, album_id,
                                       max_dim, to_rgb))
            if do_descramble and segmentation_num(scramble_id, album_id, filename_stem(path)) > 0:
                restored += 1
            ok_count += 1
        except Exception as exc:  # noqa: BLE001
            failed.append({"page": os.path.basename(path), "error": f"{type(exc).__name__}: {exc}"})

        if done % 10 == 0 or done == total:
            emit({"t": "progress", "stage": "descramble", "done": done, "total": total,
                  "ok": ok_count, "fail": len(failed)})

    if not frames:
        emit({"t": "result", "ok": False, "error": f"全部 {total} 张图都读不出来，无法生成 PDF",
              "failed": failed[:20]})
        return 1

    emit({"t": "progress", "stage": "pdf", "done": 0, "total": 1, "ok": 0, "fail": 0})
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    try:
        first, rest = frames[0], frames[1:]
        first.save(output, "PDF", save_all=True, append_images=rest,
                   resolution=150.0, quality=quality)
    except Exception as exc:  # noqa: BLE001
        emit({"t": "result", "ok": False, "error": f"PDF 写入失败：{exc}",
              "trace": traceback.format_exc()[-800:]})
        return 1

    try:
        size = os.path.getsize(output)
    except OSError:
        size = 0
    if size <= 0:
        emit({"t": "result", "ok": False, "error": "PDF 生成了但大小为 0"})
        return 1

    emit({"t": "progress", "stage": "pdf", "done": 1, "total": 1, "ok": 1, "fail": 0})
    emit({
        "t": "result",
        "ok": True,
        "output": output,
        "bytes": size,
        "pages": total,
        "pagesOk": ok_count,
        "restored": restored,
        "descrambled": do_descramble,
        "failed": failed[:50],
        "warnings": warnings[:20],
    })
    return 0


def _prepare(img, path, do_descramble, scramble_id, album_id, max_dim, to_rgb):
    """单张：还原 → 缩放 → 转 RGB。返回可直接进 PDF 的 PIL 图像。"""
    num = segmentation_num(scramble_id, album_id, filename_stem(path)) if do_descramble else 0
    if num > 0:
        img = descramble(img, num)
    if max_dim > 0 and max(img.size) > max_dim:
        ratio = max_dim / float(max(img.size))
        new_size = (max(1, int(img.size[0] * ratio)), max(1, int(img.size[1] * ratio)))
        img = img.resize(new_size, 1)  # 1 = LANCZOS
    return to_rgb(img)


def main():
    if "--check" in sys.argv[1:]:
        return run_check()
    if "--selftest" in sys.argv[1:]:
        return run_selftest()
    raw = sys.stdin.read()
    try:
        task = json.loads(raw) if raw.strip() else {}
    except Exception as exc:  # noqa: BLE001
        emit({"t": "result", "ok": False, "error": f"任务参数不是合法 JSON：{exc}"})
        return 2
    try:
        return run_task(task)
    except Exception as exc:  # noqa: BLE001
        emit({"t": "result", "ok": False, "error": f"未预期错误：{exc}",
              "trace": traceback.format_exc()[-800:]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
