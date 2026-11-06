#!/usr/bin/env python3
"""上游同步 —— 让 skill 跟上 linux-do/mapp-developer-guide 的变化。

用法：
    python3 sync_upstream.py --check     检查上游是否更新（默认动作）
    python3 sync_upstream.py --apply     拉取上游文档并刷新快照与变更笔记
    python3 sync_upstream.py --status    只看本地快照状态，不联网

退出码：
    0  UP TO DATE    上游无变化
    2  UPDATE       上游有变化，需要 --apply 后阅读 upstream-notes.md
    1  CHECK FAILED 检查本身失败（网络/限流），本地快照仍可用
    3  STALE        距上次检查超过阈值，需要检查（仍属 UP TO DATE 的信息）

设计约束：
  * 只用标准库，不装任何依赖。
  * 只访问 api.github.com 与 raw.githubusercontent.com；不可达时降级为
    "无法判定"，绝不假装上游没更新。
  * 快照存在 references/upstream-snapshot.json，是可再生的缓存。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request

REPO = "linux-do/mapp-developer-guide"
API_BASE = "https://api.github.com/repos/" + REPO

# 原始文件的内容源，按优先级排列。
# api.github.com 有未认证限流（60 次/小时），raw 直连在部分网络下不通，
# 镜像可兜底。内容哈希比对不依赖 API，所以镜像足够用。
RAW_BASES = [
    "https://raw.githubusercontent.com/" + REPO + "/master/",
    "https://ghfast.top/https://raw.githubusercontent.com/" + REPO + "/master/",
    "https://ghproxy.net/https://raw.githubusercontent.com/" + REPO + "/master/",
]

# 关注的文件：这些是规范本体，变了就要更新参考文档
WATCHED = [
    "README.md",
    "docs/developer-guide.md",
    "docs/sdk-network.md",
    "docs/server-auth.md",
    "docs/submission-review.md",
    "sdk/README.md",
    "sdk/index.d.ts",
    "sdk/pack.d.ts",
    "sdk/server.d.ts",
    "sdk/package.json",
]

# 上游文档 → 本地参考文件的对应关系
REFERENCE_MAP = {
    "docs/developer-guide.md": "references/manifest.md",
    "docs/sdk-network.md": "references/network.md",
    "docs/server-auth.md": "references/server-auth.md",
    "docs/submission-review.md": "references/review.md",
    "sdk/README.md": "references/sdk.md",
    "sdk/index.d.ts": "references/sdk.md",
}

STALE_DAYS = 14
TIMEOUT = 20

# 探测到的可用内容源缓存
_ACTIVE_BASE = None
_PROBE_README = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SNAPSHOT = os.path.join(ROOT, "references", "upstream-snapshot.json")
UPSTREAM_DIR = os.path.join(ROOT, "references", "upstream")
NOTES = os.path.join(ROOT, "references", "upstream-notes.md")


# ---------------------------------------------------------------- HTTP

def _opener():
    """直连 GitHub，不继承系统代理配置，避免代理影响内容源探测。"""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_get(url: str, raw: bool = False, timeout: int = TIMEOUT):
    headers = {"User-Agent": "mapp-developer-skill"}
    if raw:
        headers["Accept"] = "application/vnd.github.raw+json"
    else:
        headers["Accept"] = "application/vnd.github+json"
    req = urllib.request.Request(url, headers=headers)
    with _opener().open(req, timeout=timeout) as resp:
        return resp.read()


def probe_base(base: str, probe_path: str = "README.md", timeout: int = 8) -> float | None:
    """探测内容源可用性并返回耗时（秒）；不可用返回 None。"""
    start = time.monotonic()
    try:
        http_get(base + probe_path, raw=True, timeout=timeout)
        return time.monotonic() - start
    except Exception:
        return None


def pick_base() -> str | None:
    """选出一个可用的内容源并缓存。

    策略：并发探测所有源，取最快可用者。各源延迟差别很大
    （镜像常在 1 秒内，直连可能十几秒），串行探测会让整轮检查拖到分钟级。
    探测时顺手把 README 取回来复用，省掉一次往返。
    """
    global _ACTIVE_BASE
    if _ACTIVE_BASE is not None:
        return _ACTIVE_BASE

    results = {}
    probe_data = {}

    def worker(base):
        start = time.monotonic()
        try:
            data = http_get(base + "README.md", raw=True, timeout=10)
        except Exception:
            return
        elapsed = time.monotonic() - start
        results[base] = elapsed
        probe_data[base] = data

    threads = []
    for base in RAW_BASES:
        t = threading.Thread(target=worker, args=(base,), daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join(timeout=15)

    usable = [(elapsed, base) for base, elapsed in results.items()]
    if not usable:
        return None
    usable.sort()
    _ACTIVE_BASE = usable[0][1]
    _PROBE_README = probe_data.get(usable[0][1])
    return _ACTIVE_BASE


def fetch_raw(path: str) -> bytes:
    """从可用内容源取原始文件。"""
    base = pick_base()
    if base is None:
        raise RuntimeError("没有可用的内容源（raw 直连与镜像均不可达）")
    return http_get(base + path, raw=True)


def fetch_all(paths):
    """并发取多个文件，返回 {path: bytes}；单个失败不影响其他。"""
    base = pick_base()
    if base is None:
        raise RuntimeError("没有可用的内容源（raw 直连与镜像均不可达）")

    out = {}
    lock = threading.Lock()

    def worker(path):
        try:
            data = http_get(base + path, raw=True)
        except Exception as exc:
            with lock:
                print("  警告：拉取 " + path + " 失败 —— " + str(exc))
            return
        with lock:
            out[path] = data

    threads = []
    for path in paths:
        if path == "README.md" and _PROBE_README is not None:
            out[path] = _PROBE_README      # 复用探测时取到的，省一次往返
            continue
        t = threading.Thread(target=worker, args=(path,), daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join(timeout=TIMEOUT + 5)
    return out


def fetch_head_commit():
    """尽力而为取上游 commit；失败返回空串，不影响内容比对。"""
    try:
        url = API_BASE + "/commits/master"
        data = json.loads(http_get(url, timeout=6).decode("utf-8"))
        return data.get("sha", ""), (data.get("commit") or {}).get("committer", {}).get("date", "")
    except Exception:
        return "", ""


# ---------------------------------------------------------------- 快照

def load_snapshot():
    if not os.path.exists(SNAPSHOT):
        return {"repo": REPO, "files": {}, "checkedAt": None, "headCommit": None}
    try:
        with open(SNAPSHOT, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"repo": REPO, "files": {}, "checkedAt": None, "headCommit": None}


def save_snapshot(snap):
    os.makedirs(os.path.dirname(SNAPSHOT), exist_ok=True)
    with open(SNAPSHOT, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def now_iso():
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def days_since(stamp):
    if not stamp:
        return None
    try:
        then = _dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (_dt.datetime.now(_dt.timezone.utc) - then).days


# ---------------------------------------------------------------- 检查

def do_check(quiet=False):
    snap = load_snapshot()
    local_files = snap.get("files") or {}
    checked = snap.get("checkedAt")
    age = days_since(checked)

    try:
        fetched = fetch_all(WATCHED)
    except Exception as exc:
        if not quiet:
            print("CHECK FAILED  无法访问上游：" + str(exc))
            print("  本地快照仍可用（上次检查：" + (checked or "从未") + "）")
            print("  平台规范可能已变化，涉及限额/权限的问题请先确认。")
        return 1, {}

    if not fetched:
        if not quiet:
            print("CHECK FAILED  上游所有内容源都不可达")
            print("  本地快照仍可用（上次检查：" + (checked or "从未") + "）")
        return 1, {}

    changed = []
    for path in WATCHED:
        if path not in fetched:
            continue
        new_sha = hashlib.sha256(fetched[path]).hexdigest()
        if path not in local_files:
            changed.append({"path": path, "status": "added", "sha": new_sha})
        elif local_files[path] != new_sha:
            changed.append({"path": path, "status": "modified", "sha": new_sha})

    if not local_files:
        state = "INITIAL"        # 从未同步过
    elif changed:
        state = "UPDATE"
    else:
        state = "UP TO DATE"

    stale = age is None or age > STALE_DAYS
    head, head_date = fetch_head_commit()

    result = {
        "state": state,
        "changed": changed,
        "head": head,
        "headDate": head_date,
        "checkedAt": checked,
        "ageDays": age,
        "stale": stale,
        "fetched": len(fetched),
    }

    if not quiet:
        if state == "UPDATE":
            print("UPDATE AVAILABLE  上游有 " + str(len(changed)) + " 个关注文件已变化")
            for c in changed:
                ref = REFERENCE_MAP.get(c["path"], "")
                print("  ~ " + c["path"] + (("  → 需同步 " + ref) if ref else ""))
            print()
            print("  运行: python3 scripts/sync_upstream.py --apply")
            print("  然后阅读 references/upstream-notes.md，按提示更新受影响的参考文档。")
        elif state == "INITIAL":
            print("INITIAL  本地还没有上游快照")
            print("  运行: python3 scripts/sync_upstream.py --apply")
        else:
            print("UP TO DATE  上游无变化（检查于 " + (checked or "—")
                  + "，比对 " + str(result["fetched"]) + " 个文件）")
            if stale:
                print("  STALE  距上次检查已 " + str(age) + " 天（阈值 "
                      + str(STALE_DAYS) + " 天），建议运行 --apply 重新同步")
    return (2 if state == "UPDATE" else 0), result


# ---------------------------------------------------------------- 应用

def do_apply():
    try:
        fetched = fetch_all(WATCHED)
    except Exception as exc:
        print("同步失败：无法访问上游 —— " + str(exc))
        return 1
    if not fetched:
        print("同步失败：所有内容源都不可达")
        return 1

    os.makedirs(UPSTREAM_DIR, exist_ok=True)
    for path, data in fetched.items():
        dest = os.path.join(UPSTREAM_DIR, path.replace("/", "__"))
        with open(dest, "wb") as f:
            f.write(data)

    old = load_snapshot()
    old_files = old.get("files") or {}
    head, head_date = fetch_head_commit()

    # 生成变更笔记
    lines = []
    lines.append("# 上游变更记录")
    lines.append("")
    lines.append("由 `scripts/sync_upstream.py --apply` 自动生成。")
    lines.append("`references/upstream/` 下是**原始上游文档的镜像**，"
                 "用于判断本地参考文档是否需要跟进。")
    lines.append("")
    lines.append("- 上游仓库：`" + REPO + "`")
    lines.append("- 上游 commit：`" + (head or "（API 限流，未取到）") + "`")
    lines.append("- 提交时间：" + (head_date or "—"))
    lines.append("- 本次同步：" + now_iso())
    lines.append("")

    changed_paths = []
    added_paths = []
    for path in sorted(fetched):
        new_sha = hashlib.sha256(fetched[path]).hexdigest()
        if path not in old_files:
            added_paths.append(path)
        elif old_files[path] != new_sha:
            changed_paths.append(path)
    removed_paths = [p for p in old_files if p not in fetched]

    lines.append("## 本次变化")
    lines.append("")
    if not changed_paths and not added_paths and not removed_paths:
        lines.append("无变化 —— 与上次快照一致。")
    else:
        for path in changed_paths:
            ref = REFERENCE_MAP.get(path)
            lines.append("- **已修改** `" + path + "`"
                         + (" → 需检查并更新 `" + ref + "`" if ref else ""))
        for path in added_paths:
            ref = REFERENCE_MAP.get(path)
            lines.append("- **新增** `" + path + "`"
                         + (" → 需检查并更新 `" + ref + "`" if ref else ""))
        for path in removed_paths:
            lines.append("- **已删除** `" + path + "` → 从参考文档中移除相关内容")
    lines.append("")

    lines.append("## 全部关注文件")
    lines.append("")
    lines.append("| 上游文件 | 本次状态 | 对应参考文档 |")
    lines.append("| --- | --- | --- |")
    for path in sorted(fetched):
        if path in changed_paths:
            status = "已修改"
        elif path in added_paths:
            status = "新增"
        else:
            status = "未变"
        ref = REFERENCE_MAP.get(path, "—")
        lines.append("| `" + path + "` | " + status + " | `" + ref + "` |")
    lines.append("")

    lines.append("## 下一步")
    lines.append("")
    if changed_paths or added_paths:
        lines.append("1. 读 `references/upstream/` 下对应的镜像文件，与本地 `references/*.md` 逐条比对。")
        lines.append("2. 把上游新增或修改的规则**补进**对应参考文档 —— "
                     "参考文档是提炼物，上游是原文，不要整篇覆盖。")
        lines.append("3. 若限额、权限名、错误码有变，同步更新 `scripts/validate.mjs` 的常量。")
        lines.append("4. 若 `sdk/index.d.ts` 变了，核对 `references/sdk.md` 的方法表是否仍准确。")
        lines.append("5. 在本文件末尾追加一行本次更新摘要。")
    else:
        lines.append("上游无变化，无需处理。")
    lines.append("")

    # 保留人工追加的摘要（分隔线之后）
    if os.path.exists(NOTES):
        with open(NOTES, "r", encoding="utf-8") as f:
            prev = f.read()
        marker = "\n<!-- HISTORY -->\n"
        if marker in prev:
            history = prev.split(marker, 1)[1]
            lines.append("<!-- HISTORY -->" + history)

    with open(NOTES, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    # 更新快照
    new_files = {}
    for path, data in fetched.items():
        new_files[path] = hashlib.sha256(data).hexdigest()
    snap = {
        "repo": REPO,
        "branch": "master",
        "headCommit": head,
        "headDate": head_date,
        "checkedAt": now_iso(),
        "files": new_files,
    }
    save_snapshot(snap)

    print("同步完成")
    print("  写入 " + str(len(fetched)) + " 个文件到 references/upstream/")
    if changed_paths or added_paths:
        print("  有变化：" + str(len(changed_paths) + len(added_paths)) + " 个文件")
        print("  下一步：阅读 references/upstream-notes.md 并更新受影响的参考文档")
    else:
        print("  与上次快照一致")
    return 0


def do_status():
    snap = load_snapshot()
    files = snap.get("files") or {}
    age = days_since(snap.get("checkedAt"))
    print("仓库       " + REPO)
    print("分支       " + (snap.get("branch") or "master"))
    print("上次 commit " + (snap.get("headCommit") or "—"))
    print("上次检查   " + (snap.get("checkedAt") or "从未")
          + ("（" + str(age) + " 天前）" if age is not None else ""))
    print("快照文件   " + str(len(files)) + " 个")
    if age is not None and age > STALE_DAYS:
        print("状态       STALE —— 超过 " + str(STALE_DAYS) + " 天未检查")
    print()
    print("关注文件：")
    for path in sorted(files):
        ref = REFERENCE_MAP.get(path, "")
        print("  " + path + ("  → " + ref if ref else ""))
    return 0


def main():
    ap = argparse.ArgumentParser(description="同步上游 mapp-developer-guide")
    ap.add_argument("--check", action="store_true", help="检查上游是否更新")
    ap.add_argument("--apply", action="store_true", help="拉取上游并刷新快照")
    ap.add_argument("--status", action="store_true", help="显示本地快照状态")
    args = ap.parse_args()

    if args.apply:
        sys.exit(do_apply())
    if args.status:
        sys.exit(do_status())
    code, _ = do_check()
    sys.exit(code)


if __name__ == "__main__":
    main()
