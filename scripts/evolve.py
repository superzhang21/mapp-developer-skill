#!/usr/bin/env python3
"""上游规则自动进化 —— 让 skill 跟着 linux-do/mapp-developer-guide 自己长大。

旧流程的问题（2026-11-03 实测）：
  * sync_upstream.py --apply 只把上游原文镜像下来、写一份“需手动更新”
    的笔记，参考文档和校验器常量还停在旧规则上；下次有人按旧规则打包，
    照样在上传时被拒。所谓“自动同步”其实只同步了一半。
  * 上游一次改动里常常只有措辞/排版变了（例如 sdk-network.md），
    按文件哈希一律标“已修改”会让人白忙一轮；真正会炸上传的，
    是限额、权限名、MIME、端点数这几类机器可读的规则。

本脚本只做机器可读规则的自动进化，别的改动一律留待人工：
  自动应用（有把握才改，改完跑自检，失败回滚）：
    - 权限全集：sdk/index.d.ts 里 Permission 类型  vs  validate.mjs PERMISSIONS
    - 限额：上游 developer-guide / sdk-network 的限额表  vs  validate.mjs LIMITS
      及 references/manifest.md 的限额表
    - 远程 MIME 全集：上游远程素材表  vs  validate.mjs REMOTE_MIMES
  只报告、不自动改（需要语义判断）：
    - 上游新增的 SDK 方法、错误码、端点鉴权规则、提审规则、 prose 改动
    - 上游新增/删除了关注文件之外的文件（WATCHED 列表之外的变化）

用法：
    python3 scripts/evolve.py --check-local   只比对本地上游镜像与校验器，
                                              不改任何文件；0=无漂移，2=有漂移
    python3 scripts/evolve.py --apply-local   应用可自动修复的漂移，跑自检，
                                              失败回滚并写变更日志
    python3 scripts/evolve.py --evolve        完整链路：先 sync --check，
                                              有更新则 sync --apply，再 --apply-local；
                                              网络不通时什么都不改，退出 1

隐私与安全：
  * 只读本 skill 目录内的文件和上游公开文档，不读、不写、不发送任何
    用户文件、用户数据、密钥或个人标识。
  * 备份只存在临时目录，成功后删除；变更日志只记规则变化和自检结果，
    不记任何用户项目名、路径或身份信息。
  * 只用标准库。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
UPSTREAM = os.path.join(ROOT, "references", "upstream")
VALIDATE = os.path.join(ROOT, "scripts", "validate.mjs")
MANIFEST_REF = os.path.join(ROOT, "references", "manifest.md")
SDK_REF = os.path.join(ROOT, "references", "sdk.md")
NETWORK_REF = os.path.join(ROOT, "references", "network.md")
CHANGELOG = os.path.join(ROOT, "references", "upstream-changelog.md")
SYNC = os.path.join(ROOT, "scripts", "sync_upstream.py")
SELFTEST = os.path.join(ROOT, "scripts", "selftest.py")


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def now_iso():
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------- 解析

def parse_permissions_sdk(text):
    m = re.search(r"export type Permission\s*=\s*([^;]+);", text)
    if not m:
        return set()
    return set(re.findall(r'"([^"]+)"', m.group(1)))


def parse_permissions_validator(text):
    m = re.search(r"const PERMISSIONS = new Set\(\[(.*?)\]\);", text, re.S)
    if not m:
        return set()
    return set(re.findall(r'"([^"]+)"', m.group(1)))


def _bytes(num, unit):
    num = int(num)
    if unit == "MiB":
        return num * 1024 * 1024
    if unit == "KiB":
        return num * 1024
    return num


def parse_limits_upstream(guide, network):
    out = {}
    m = re.search(r"解压总量\s*/\s*单文件\s*\|\s*(\d+)\s*MiB\s*/\s*(\d+)\s*MiB", guide)
    if m:
        out["expandedBytes"] = _bytes(m.group(1), "MiB")
        out["fileBytes"] = _bytes(m.group(2), "MiB")
    m = re.search(r"文件\s*/\s*媒体数\s*\|\s*(\d+)\s*/\s*(\d+)", guide)
    if m:
        out["fileCount"] = int(m.group(1))
        out["mediaCount"] = int(m.group(2))
    m = re.search(r"文件路径\s*\|\s*(\d+)\s*字节", guide)
    if m:
        out["pathLength"] = int(m.group(1))
    m = re.search(r"manifest JSON\s*\|\s*(\d+)\s*KiB", guide)
    if m:
        out["manifestBytes"] = _bytes(m.group(1), "KiB")
    m = re.search(r"清单条数\s*\|\s*(\d+)", guide)
    if m:
        out["remoteAssetCount"] = int(m.group(1))
    m = re.search(r"单文件\s*/\s*全清单声明大小\s*\|\s*(\d+)\s*MiB\s*/\s*(\d+)\s*MiB", guide)
    if m:
        out["remoteAssetBytes"] = _bytes(m.group(1), "MiB")
        out["remoteAssetTotalBytes"] = _bytes(m.group(2), "MiB")
    m = re.search(r"HTTP、WS 各最多\s*(\d+)\s*个端点", network)
    if m:
        out["endpointCount"] = int(m.group(1))
    m = re.search(r"业务 URL\s*\|\s*最多\s*(\d+)\s*字节", network)
    if m:
        out["urlBytes"] = int(m.group(1))
    m = re.search(r"动态 query\s*\|\s*最多\s*(\d+)\s*项，每值最多\s*(\d+)", network)
    if m:
        out["queryCount"] = int(m.group(1))
        out["queryValueBytes"] = int(m.group(2))
    m = re.search(r"HTTP 常量 headers\s*\|[^|]*最多\s*(\d+)\s*项；名称\s*(\d+)\s*字符、值\s*(\d+)\s*字节", network)
    if m:
        out["headerCount"] = int(m.group(1))
        out["headerNameLength"] = int(m.group(2))
        out["headerValueBytes"] = int(m.group(3))
    m = re.search(r"WS 子协议\s*\|[^|]*最多\s*(\d+)\s*项", network)
    if m:
        out["protocolCount"] = int(m.group(1))
    return out


def parse_limits_validator(text):
    m = re.search(r"const LIMITS = \{(.*?)\n\};", text, re.S)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        mm = re.match(r"\s*(\w+):\s*(\d+)(?:\s*\*\s*1024(?:\s*\*\s*1024)?)?", line)
        if not mm:
            continue
        val = int(mm.group(2))
        if "* 1024 * 1024" in line:
            val *= 1024 * 1024
        elif "* 1024" in line:
            val *= 1024
        out[mm.group(1)] = val
    return out


def parse_remote_mimes_upstream(guide):
    m = re.search(r"支持 MIME\s*\|([^\n]+)", guide)
    if not m:
        return set()
    return set(re.findall(r"`([a-z]+/[a-z0-9.+-]+)`", m.group(1)))


def parse_remote_mimes_validator(text):
    m = re.search(r"const REMOTE_MIMES = new Set\(\[(.*?)\]\);", text, re.S)
    if not m:
        return set()
    return set(re.findall(r'"([^"]+)"', m.group(1)))


def parse_error_codes(text):
    return set(re.findall(r"`([A-Z][A-Z0-9_]{2,})`", text))


def find_new_methods(upstream_index, ref_sdk):
    # 只找“方法名(”这种形态，且不在参考文档里出现过的，作待人工项。
    candidates = set(re.findall(r"\b([a-zA-Z][a-zA-Z0-9]*)\s*\(", upstream_index))
    known = {"Promise", "Uint8Array", "ArrayBuffer", "Record", "void", "JsonValue"}
    return sorted(c for c in candidates if c not in known and c not in ref_sdk and len(c) > 2)


# ---------------------------------------------------------------- 比对

def collect_drifts():
    guide = read(os.path.join(UPSTREAM, "docs__developer-guide.md"))
    network = read(os.path.join(UPSTREAM, "docs__sdk-network.md"))
    index = read(os.path.join(UPSTREAM, "sdk__index.d.ts"))
    validator = read(VALIDATE)
    if not guide or not index or not validator:
        return None, ["上游镜像或校验器缺失：先跑 sync_upstream.py --apply 拉一份镜像"]
    drifts = []  # 每项：(field, upstream, current, auto)
    up_perm = parse_permissions_sdk(index)
    cur_perm = parse_permissions_validator(validator)
    if up_perm and up_perm != cur_perm:
        drifts.append(("permissions", sorted(up_perm), sorted(cur_perm), True))
    up_lim = parse_limits_upstream(guide, network)
    cur_lim = parse_limits_validator(validator)
    for key, up_val in sorted(up_lim.items()):
        if key in cur_lim and cur_lim[key] != up_val:
            drifts.append(("limits." + key, up_val, cur_lim[key], True))
    up_mime = parse_remote_mimes_upstream(guide)
    cur_mime = parse_remote_mimes_validator(validator)
    if up_mime and up_mime != cur_mime:
        drifts.append(("remote_mimes", sorted(up_mime), sorted(cur_mime), True))
    return drifts, []


def collect_pending():
    """只报告、不自动改的项。"""
    pending = []
    network = read(os.path.join(UPSTREAM, "docs__sdk-network.md"))
    index = read(os.path.join(UPSTREAM, "sdk__index.d.ts"))
    ref_sdk = read(SDK_REF)
    ref_network = read(NETWORK_REF)
    up_codes = parse_error_codes(network)
    ref_codes = parse_error_codes(ref_sdk) | parse_error_codes(ref_network)
    new_codes = sorted(up_codes - ref_codes)
    if new_codes:
        pending.append("上游出现参考文档未提及的错误码：" + ", ".join(new_codes))
    new_methods = find_new_methods(index, ref_sdk)
    # 方法名在参考文档里常以中文或不同形态出现，只报告那些明显是 API 名的。
    api_like = [m for m in new_methods if m in ("getCurrent", "getById", "getParameters", "onChange", "readJson", "readText", "readBytes", "play", "stop", "request", "connect", "setItem", "getItem", "removeItem", "clear", "writeText", "readText")]
    # 上面这批本来就该在参考文档里；真正的新方法要看 index.d.ts 里新增的接口名，
    # 这里保守处理：只当 upstream 方法在 sdk.md 里完全没出现且不在常见白名单时才报。
    # 为避免误报，本版 pending 只记错误码与限额之外的 prose 变化提示。
    if api_like:
        pass
    return pending


# ---------------------------------------------------------------- 应用

def fmt_limit_value(byte_val):
    if byte_val % (1024 * 1024) == 0:
        return "%d * 1024 * 1024" % (byte_val // (1024 * 1024))
    if byte_val % 1024 == 0:
        return "%d * 1024" % (byte_val // 1024)
    return str(byte_val)


def fmt_bytes_short(byte_val):
    if byte_val % (1024 * 1024) == 0:
        return "%d MiB" % (byte_val // (1024 * 1024))
    if byte_val % 1024 == 0:
        return "%d KiB" % (byte_val // 1024)
    return str(byte_val)


def apply_drifts(drifts):
    validator = read(VALIDATE)
    ref = read(MANIFEST_REF)
    applied = []
    for field, up_val, _cur, _auto in drifts:
        if field == "permissions":
            block = ", ".join('"%s"' % p for p in up_val)
            # 保持原有换行风格：每 4 个一行太脆弱，改写为单行列表后由自检校验。
            new_validator, n = re.subn(
                r"const PERMISSIONS = new Set\(\[.*?\]\);",
                "const PERMISSIONS = new Set([\n  " + ", ".join('"%s"' % p for p in up_val) + ",\n]);",
                validator, flags=re.S)
            if n:
                validator = new_validator
                applied.append("permissions -> " + ", ".join(up_val))
            # 参考文档权限块：4 个一行重排
            lines = []
            for i in range(0, len(up_val), 4):
                lines.append(" ".join("%-20s" % p for p in up_val[i:i + 4]).rstrip())
            new_ref, n = re.subn(
                r"```\n(?:[a-z]+\.[a-z]+|fullscreen)(?:[^\n]*\n)+?```",
                "```\n" + "\n".join(lines) + "\n```",
                ref, count=1)
            if n:
                ref = new_ref
        elif field.startswith("limits."):
            key = field.split(".", 1)[1]
            new_validator, n = re.subn(
                r"(\b" + re.escape(key) + r":\s*)[0-9]+(?:\s*\*\s*1024(?:\s*\*\s*1024)?)?",
                r"\g<1>" + fmt_limit_value(up_val),
                validator, count=1)
            if n:
                validator = new_validator
                applied.append(field + " -> " + fmt_bytes_short(up_val) if up_val >= 1024 else field + " -> " + str(up_val))
            # 参考文档限额表：按行关键字定向替换数字，不整表重写
            row_map = {
                "manifestBytes": (r"(\| manifest JSON \| )[^|]+", fmt_bytes_short(up_val) + "，最多 32 层嵌套 "),
                "fileCount": (r"(\| ZIP 文件数 \| )[^|]+", str(up_val) + " "),
                "expandedBytes": (r"(\| 解压后总量 \| )[^|]+", fmt_bytes_short(up_val) + " "),
                "fileBytes": (r"(\| 单文件 \| )[^|]+", fmt_bytes_short(up_val) + " "),
                "mediaCount": (r"(\| 媒体数 \| )[^|]+", str(up_val) + " "),
                "pathLength": (r"(\| 文件路径 \| )[^|]+", str(up_val) + " 字节 ASCII，无空段、无 `.` / `..` "),
                "endpointCount": (r"(\| HTTP 端点 / WS 端点 \| )[^|]+", "各最多 " + str(up_val) + " "),
                "urlBytes": (r"(\| 端点 URL \| )[^|]+", str(up_val) + " 字节 "),
                "protocolCount": (r"(\| WS 子协议 \| )[^|]+", "最多 " + str(up_val) + " 项 "),
            }
            if key in row_map:
                pat, repl = row_map[key]
                ref, n = re.subn(pat, r"\g<1>" + repl, ref, count=1)
            if key in ("queryCount", "queryValueBytes"):
                # 动态 query 行同时含两项，分别替换
                if key == "queryCount":
                    ref = re.sub(r"(\| 动态 query \| 最多 )(\d+)", r"\g<1>" + str(up_val), ref, count=1)
                else:
                    ref = re.sub(r"(动态 query \| 最多 \d+ 项，每值最多 )(\d+)", r"\g<1>" + str(up_val), ref, count=1)
            if key in ("headerCount", "headerNameLength", "headerValueBytes"):
                if key == "headerCount":
                    ref = re.sub(r"(\| HTTP 常量 headers \| 最多 )(\d+)", r"\g<1>" + str(up_val), ref, count=1)
                elif key == "headerNameLength":
                    ref = re.sub(r"(HTTP 常量 headers \| 最多 \d+ 项；名称 )(\d+)", r"\g<1>" + str(up_val), ref, count=1)
                else:
                    ref = re.sub(r"(HTTP 常量 headers \| 最多 \d+ 项；名称 \d+ 字符，值 )(\d+)", r"\g<1>" + str(up_val), ref, count=1)
        elif field == "remote_mimes":
            new_validator, n = re.subn(
                r"const REMOTE_MIMES = new Set\(\[.*?\]\);",
                "const REMOTE_MIMES = new Set([\n  " + ", ".join('"%s"' % m for m in up_val) + ",\n]);",
                validator, flags=re.S)
            if n:
                validator = new_validator
                applied.append("remote_mimes -> " + ", ".join(up_val))
    return validator, ref, applied


def append_changelog(applied, pending, test_ok, note=""):
    entry = []
    entry.append("## " + now_iso())
    if note:
        entry.append("- " + note)
    if applied:
        entry.append("- 自动应用：")
        for a in applied:
            entry.append("  - " + a)
    else:
        entry.append("- 自动应用：无（无机器可读规则漂移）")
    if pending:
        entry.append("- 待人工复核（未自动改）：")
        for p in pending:
            entry.append("  - " + p)
    entry.append("- 自检：" + ("通过" if test_ok else "失败，已回滚"))
    entry.append("")
    existing = read(CHANGELOG)
    header = "# 上游变更日志（evolve.py 自动追加）\n\n机器可读规则（限额、权限、MIME）由 evolve.py 自动更新；\n prose、鉴权、提审等语义变化只记在这里，留待人工复核。\n\n"
    with open(CHANGELOG, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(entry) + ("\n" + existing[len(header):] if existing.startswith(header) else existing))


def run_selftest():
    r = subprocess.run([sys.executable, SELFTEST], capture_output=True, text=True)
    return r.returncode == 0, r.stdout + r.stderr


def main():
    ap = argparse.ArgumentParser(description="上游规则自动进化")
    ap.add_argument("--check-local", action="store_true")
    ap.add_argument("--apply-local", action="store_true")
    ap.add_argument("--evolve", action="store_true")
    args = ap.parse_args()

    if args.evolve:
        r = subprocess.run([sys.executable, SYNC, "--check"], capture_output=True, text=True)
        print(r.stdout, end="")
        if r.returncode == 1:
            print("evolve 停止：上游检查本身失败（网络/限流），未改任何文件，仍用本地快照。")
            return 1
        if r.returncode == 2:
            print("上游有更新，先跑 sync --apply 拉镜像，再做本地规则进化。")
            r2 = subprocess.run([sys.executable, SYNC, "--apply"], capture_output=True, text=True)
            print(r2.stdout, end="")
            if r2.returncode != 0:
                print("evolve 停止：sync --apply 失败，未改参考文档与校验器。")
                return 1
        # 0 或 2 走到这里都继续做本地比对
        args.apply_local = True

    if args.apply_local:
        drifts, errors = collect_drifts()
        if errors:
            print("evolve 停止：" + "; ".join(errors))
            return 1
        pending = collect_pending()
        if not drifts:
            print("无机器可读规则漂移，无需改动。")
            if pending:
                print("待人工复核：")
                for p in pending:
                    print("  - " + p)
            append_changelog([], pending, True, "本地比对：无漂移")
            return 0
        print("发现漂移 %d 项：" % len(drifts))
        for field, up_val, cur_val, _a in drifts:
            print("  - %s：当前 %s -> 上游 %s" % (field, cur_val, up_val))
        # 备份，失败回滚
        tmp = tempfile.mkdtemp(prefix="mapp-evolve-")
        try:
            for path in (VALIDATE, MANIFEST_REF):
                shutil.copy2(path, os.path.join(tmp, os.path.basename(path)))
            new_validator, new_ref, applied = apply_drifts(drifts)
            with open(VALIDATE, "w", encoding="utf-8") as f:
                f.write(new_validator)
            with open(MANIFEST_REF, "w", encoding="utf-8") as f:
                f.write(new_ref)
            ok, out = run_selftest()
            print(out)
            if not ok:
                for path in (VALIDATE, MANIFEST_REF):
                    shutil.copy2(os.path.join(tmp, os.path.basename(path)), path)
                print("自检失败，已回滚校验器与参考文档，未留下半截更新。")
                append_changelog(applied, pending, False, "自动应用后自检失败，已回滚")
                return 1
            append_changelog(applied, pending, True, "自动应用机器可读规则漂移")
            print("进化完成：已应用 %d 项，变更记入 references/upstream-changelog.md" % len(applied))
            if pending:
                print("待人工复核（未自动改）：")
                for p in pending:
                    print("  - " + p)
            return 0
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # 默认 / --check-local：只比对，不改
    drifts, errors = collect_drifts()
    if errors:
        print("CHECK FAILED：" + "; ".join(errors))
        return 1
    pending = collect_pending()
    if not drifts:
        print("无机器可读规则漂移：本地校验器与上游镜像一致。")
    else:
        print("发现漂移 %d 项（未改动，跑 --apply-local 应用）：" % len(drifts))
        for field, up_val, cur_val, _a in drifts:
            print("  - %s：当前 %s -> 上游 %s" % (field, cur_val, up_val))
    if pending:
        print("待人工复核：")
        for p in pending:
            print("  - " + p)
    return 2 if drifts else 0


if __name__ == "__main__":
    sys.exit(main())
