#!/usr/bin/env python3
"""skill 自检 —— 分发后确认这份技能本身是好的。

检查项：
  1. 目录结构完整（SKILL.md、scripts、references、assets）
  2. Python / Node 脚本语法正确
  3. validate.mjs 能正确拒绝坏 manifest、接受好 manifest
  4. scaffold.py 能生成项目
  5. 脱敏：不含本地路径或个人标识

用法：
    python3 scripts/selftest.py
退出码：0 全部通过 / 1 有失败项
"""

from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PASS, FAIL = [], []


def ok(name):
    PASS.append(name)
    print("  ✓ " + name)


def bad(name, detail=""):
    FAIL.append(name + ((": " + detail) if detail else ""))
    print("  ✗ " + name + ((": " + detail) if detail else ""))


def run(cmd, cwd=None, env=None):
    merged = None
    if env is not None:
        merged = dict(os.environ)
        merged.update(env)
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, shell=False, env=merged)


def check_structure():
    print("[1/6] 目录结构")
    required = [
        "SKILL.md", "README.md", "LICENSE",
        "scripts/validate.mjs", "scripts/sync_upstream.py",
        "scripts/pack.mjs", "scripts/scaffold.py",
        "scripts/check_zip.mjs", "scripts/evolve.py",
        "references/manifest.md", "references/sdk.md",
        "references/network.md", "references/server-auth.md",
        "references/review.md",
        "assets/template/manifest.json",
        "assets/template/src/main.ts",
        "assets/template/src/host.ts",
        "assets/template/scripts/package.ts",
    ]
    missing = [p for p in required if not os.path.exists(os.path.join(ROOT, p))]
    if missing:
        bad("结构完整", "缺少 " + ", ".join(missing))
    else:
        ok("结构完整（%d 个必需文件）" % len(required))

    # SKILL.md frontmatter
    skill_md = os.path.join(ROOT, "SKILL.md")
    if os.path.exists(skill_md):
        with open(skill_md, encoding="utf-8") as f:
            head = f.read(600)
        if head.startswith("---") and "name:" in head and "description:" in head:
            ok("SKILL.md frontmatter 完整")
        else:
            bad("SKILL.md frontmatter", "缺少 name 或 description")


def check_syntax():
    print("[2/6] 脚本语法")
    for rel in ["scripts/sync_upstream.py", "scripts/scaffold.py", "scripts/selftest.py", "scripts/evolve.py"]:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            bad(rel + " 存在")
            continue
        try:
            with open(p, encoding="utf-8") as f:
                ast.parse(f.read())
            ok(rel + " 语法正确")
        except SyntaxError as e:
            bad(rel + " 语法", str(e))

    for rel in ["scripts/validate.mjs", "scripts/pack.mjs", "scripts/check_zip.mjs"]:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            bad(rel + " 存在")
            continue
        r = run(["node", "--check", p])
        if r.returncode == 0:
            ok(rel + " 语法正确")
        else:
            bad(rel + " 语法", r.stderr.strip().splitlines()[-1] if r.stderr else "")


def check_validator():
    print("[3/6] 校验器行为")
    tmp = tempfile.mkdtemp(prefix="mapp-selftest-")
    try:
        web = os.path.join(tmp, "dist", "web")
        os.makedirs(web)
        for name in ["index.html", "app.css", "strings.json"]:
            with open(os.path.join(web, name), "w", encoding="utf-8") as f:
                f.write("<div>x</div>" if name == "index.html" else "{}")
        with open(os.path.join(web, "app.js"), "w", encoding="utf-8") as f:
            f.write("// app")

        good = {
            "format": 1,
            "id": "01a1966e-935a-79e0-8c76-9b0f7552c578",
            "version": "1.0.0",
            "entry": "index.html", "script": "app.js", "style": "app.css",
            "permissions": ["user.read", "theme.read"],
            "media": {},
        }
        mpath = os.path.join(tmp, "manifest.json")
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(good, f)

        r = run(["node", os.path.join(ROOT, "scripts", "validate.mjs"), tmp])
        if r.returncode == 0:
            ok("合法 manifest 通过")
        else:
            bad("合法 manifest 通过", r.stdout.strip().splitlines()[-1] if r.stdout else "")

        # 几类必须被拒的错误
        rejects = [
            ("非法 id", {"id": "nope"}),
            ("版本不是三段", {"version": "1.0"}),
            ("未知权限", {"permissions": ["bad.perm"]}),
            ("http 端点", {"endpoints": {"a": {"url": "http://x.example.com/p",
                                              "method": "GET", "auth": "none"}}}),
            ("WS 非 platform", {"websockets": {"w": {"url": "wss://x.example.com/w",
                                                     "auth": "none"}}}),
            ("remote_assets 越权", {"remote_assets": {"i/a.png": {
                "url": "https://cdn.example.com/a.png", "sha256": "a" * 64,
                "size": 10, "mime": "image/png"}}}),
        ]
        missed = []
        for label, patch in rejects:
            bad_manifest = dict(good)
            bad_manifest.update(patch)
            with open(mpath, "w", encoding="utf-8") as f:
                json.dump(bad_manifest, f)
            r = run(["node", os.path.join(ROOT, "scripts", "validate.mjs"), tmp])
            if r.returncode == 0:
                missed.append(label)
        if missed:
            bad("错误 manifest 被拒绝", "未拦住：" + ", ".join(missed))
        else:
            ok("错误 manifest 被拒绝（%d 类）" % len(rejects))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check_scaffold():
    print("[4/6] 脚手架")
    tmp = tempfile.mkdtemp(prefix="mapp-scaffold-")
    try:
        target = os.path.join(tmp, "proj")
        r = run([sys.executable, os.path.join(ROOT, "scripts", "scaffold.py"),
                 target, "--name", "自检应用"])
        if r.returncode != 0:
            bad("scaffold.py 运行", r.stdout.strip()[-200:] + r.stderr.strip()[-200:])
            return
        need = ["manifest.json", "package.json", "tsconfig.json", "vite.config.ts",
                "src/main.ts", "src/host.ts", "src/template.html",
                "src/style.css", "src/strings.json", "scripts/package.ts"]
        missing = [p for p in need if not os.path.exists(os.path.join(target, p))]
        if missing:
            bad("脚手架产物完整", "缺少 " + ", ".join(missing))
            return
        ok("脚手架产物完整（%d 个文件）" % len(need))

        with open(os.path.join(target, "manifest.json"), encoding="utf-8") as f:
            m = json.load(f)
        if m.get("id") == "00000000-0000-7000-8000-000000000000" and m.get("format") == 1:
            ok("模板 manifest 使用占位 ID")
        else:
            bad("模板 manifest 使用占位 ID", str(m.get("id")))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check_privacy():
    print("[5/6] 脱敏")
    # 通用模式，不写任何具体人名、项目名、用户名：把具体名字写进检查脚本，
    # 反而会把那个名字永远带进分发的 skill 里。真正属于某个人的信息，
    # 由使用人在本地另外核对，不靠分发包里的黑名单。
    # 这里只拦“任何人一看就知道是私人信息”的形态，example.* 示例域名除外。
    import re
    patterns = [
        (re.compile(r"/home/[^/\s]+|/Users/[^/\s]+|C:\\Users\\[^\\\s]+|AppData"), "本地绝对路径"),
        (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "疑似真实邮箱"),
        (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "疑似手机号"),
        (re.compile(r"sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}"), "疑似密钥"),
        (re.compile(r"BEGIN (RSA |EC )?PRIVATE KEY"), "私钥"),
    ]
    hits = []
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
        for name in files:
            if not name.endswith((".md", ".py", ".mjs", ".ts", ".json", ".yaml", ".css", ".html", ".sh")):
                continue
            pth = os.path.join(root, name)
            rel = os.path.relpath(pth, ROOT).replace("\\", "/")
            if "upstream" in rel:
                continue          # 上游镜像本身可能含示例路径
            if rel.endswith("selftest.py") or rel.endswith("scripts/package.sh"):
                continue          # 这两个文件含有检测用的正则字面量，不是真实路径；
                                  # package.sh 自身的打包检查本来就不扫 .sh 文件
            try:
                text = open(pth, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            for rx, label in patterns:
                for m in rx.finditer(text):
                    if label == "疑似真实邮箱" and ("example.com" in m.group(0) or "example.org" in m.group(0) or "example.net" in m.group(0)):
                        continue
                    if label == "本地绝对路径" and "<" in m.group(0):
                        continue
                    hits.append(label + " @ " + rel)
                    break
    if hits:
        bad("不含本地信息", "; ".join(hits[:5]))
    else:
        ok("不含本地信息（通用模式，未含具体人名/项目名）")


def check_pack_zip_evolve():
    print("[6/6] 打包与进化")
    tmp = tempfile.mkdtemp(prefix="mapp-pack-")
    try:
        web = os.path.join(tmp, "web")
        os.makedirs(os.path.join(web, "data"))
        for name, content in [("index.html", "<div>x</div>"), ("app.js", "// app"), ("app.css", ""), ("strings.json", "{}")]:
            with open(os.path.join(web, name), "w", encoding="utf-8") as f:
                f.write(content)
        with open(os.path.join(web, "data", "game.json"), "w", encoding="utf-8") as f:
            f.write("{}")
        good = {
            "format": 1,
            "id": "01a1966e-935a-79e0-8c76-9b0f7552c578",
            "version": "1.0.0",
            "entry": "index.html", "script": "app.js", "style": "app.css",
            "permissions": ["user.read", "theme.read"],
            "assets": ["data/game.json"],
            "media": {},
        }
        mpath = os.path.join(web, "manifest.json")
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(good, f)
        out = os.path.join(tmp, "out")
        r = run(["node", os.path.join(ROOT, "scripts", "pack.mjs"), mpath, web, out])
        if r.returncode != 0:
            bad("pack.mjs 打包", r.stderr.strip()[-200:])
            return
        zpath = os.path.join(out, "app.zip")
        # 关键回归：包里必须有 manifest.json（2026-11-03 旧版漏打的 bug）
        import zipfile
        try:
            names = zipfile.ZipFile(zpath).namelist()
        except Exception as e:
            bad("pack 产物是合法 ZIP", str(e))
            return
        if "manifest.json" not in names:
            bad("pack 产物含 manifest.json", "包内文件：" + ", ".join(names))
        else:
            ok("pack 产物含 manifest.json")
        r = run(["node", os.path.join(ROOT, "scripts", "check_zip.mjs"), zpath])
        if r.returncode == 0:
            ok("check_zip.mjs 通过打包产物")
        else:
            bad("check_zip.mjs 通过打包产物", (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr).strip() else "")
        r = run([sys.executable, os.path.join(ROOT, "scripts", "evolve.py"), "--check-local"])
        if r.returncode == 0:
            ok("evolve.py --check-local 无漂移")
        else:
            bad("evolve.py --check-local", (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr).strip() else "")
        # 应用 ID 门禁：占位 ID 默认拒绝打包与验包，显式放行或 MINI_APP_ID 覆盖才放行
        ph = dict(good)
        ph["id"] = "00000000-0000-7000-8000-000000000000"
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(ph, f)
        r = run(["node", os.path.join(ROOT, "scripts", "pack.mjs"), mpath, web, out])
        if r.returncode != 0:
            ok("占位 ID 默认拒绝打包")
        else:
            bad("占位 ID 默认拒绝打包", "pack 竟然成功了")
        r = run(["node", os.path.join(ROOT, "scripts", "pack.mjs"), mpath, web, out, "--allow-placeholder"])
        if r.returncode == 0:
            ok("占位 ID 显式放行可打包（仅本地测试）")
            zpath2 = os.path.join(out, "app.zip")
            r = run(["node", os.path.join(ROOT, "scripts", "check_zip.mjs"), zpath2])
            if r.returncode != 0:
                ok("占位包默认拒绝验包")
            else:
                bad("占位包默认拒绝验包", "check_zip 竟然通过了")
            r = run(["node", os.path.join(ROOT, "scripts", "check_zip.mjs"), zpath2, "--allow-placeholder"])
            if r.returncode == 0:
                ok("占位包显式放行可验包（仅本地测试）")
            else:
                bad("占位包显式放行可验包", (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr).strip() else "")
        else:
            bad("占位 ID 显式放行可打包", r.stderr.strip()[-200:])
        real_id = "01a1966e-935a-79e0-8c76-9b0f7552c578"
        r = run(["node", os.path.join(ROOT, "scripts", "pack.mjs"), mpath, web, out],
                env={"MINI_APP_ID": real_id})
        if r.returncode == 0:
            import zipfile as _zf
            mid = json.loads(_zf.ZipFile(os.path.join(out, "app.zip")).read("manifest.json"))
            if mid.get("id") == real_id:
                ok("MINI_APP_ID 覆盖占位 ID 后可打包")
            else:
                bad("MINI_APP_ID 覆盖占位 ID 后可打包", "包内 id=" + str(mid.get("id")))
        else:
            bad("MINI_APP_ID 覆盖占位 ID 后可打包", r.stderr.strip()[-200:])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    print("mapp-developer skill 自检")
    print("=" * 46)
    check_structure()
    check_syntax()
    check_validator()
    check_scaffold()
    check_privacy()
    check_pack_zip_evolve()
    print("=" * 46)
    print("通过 %d 项，失败 %d 项" % (len(PASS), len(FAIL)))
    if FAIL:
        for f in FAIL:
            print("  ✗ " + f)
        return 1
    print("全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
