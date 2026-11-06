#!/usr/bin/env python3
"""从 assets/template 生成一个可构建的微应用项目。

用法：
    python3 scaffold.py <目标目录> [--name 应用名] [--id <app-id>]

生成后：
    cd <目标目录>
    bun install --frozen-lockfile
    MINI_APP_ID=<app-id> MINI_APP_VERSION=1.0.0 bun run build

模板里的 app-id 是占位符，必须换成社区应用页面分配的真实 UUIDv7。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TEMPLATE = os.path.join(ROOT, "assets", "template")

README = """# {name}

由 mapp-developer skill 的模板生成。

## 第 0 步：先拿应用 ID，再打包（必做）

1. 去社区个人资料的应用页创建应用，填好名称、说明和图标。
2. 从应用页原样复制它分配的 UUIDv7，不要自己编。
3. 构建时用 `MINI_APP_ID=<应用ID>` 交给打包流程，或直接写进 `manifest.json` 的 `id`。

模板自带的 id 是占位符 `00000000-0000-7000-8000-000000000000`，
打包脚本默认会拒绝用它打包（见下），用它打出的包上传必定报 `APP_ID_MISMATCH`。
仅本地脚手架测试可用 `--allow-placeholder` / `MINI_APP_ALLOW_PLACEHOLDER_ID=1` 放行，
放行产物不能上传。

## 构建

```sh
bun install --frozen-lockfile
MINI_APP_ID=<应用ID> MINI_APP_VERSION=1.0.0 bun run build
```

产物在 `dist/package/app.zip`，上传到社区的沙箱页签。

## 调试真实平台能力

本地 `bun run dev` 只调试布局与业务逻辑，不含真实 SDK。
需要真实能力时构建调试包并上传沙箱：

```sh
MINI_APP_ID=<应用ID> MINI_APP_VERSION=1.0.1 bun run build:debug
```

然后在 DevTools 里选择微应用 iframe 查看日志与断点。

## 提交前自检

```sh
node <skill目录>/scripts/validate.mjs .
```

## 目录

```text
manifest.json      平台契约：权限、资源、端点
src/main.ts        入口：连接 SDK → 渲染 → lifecycle.ready()
src/host.ts        SDK 适配层，能力缺失时优雅降级
src/template.html  正文片段（不含 <script> 与内联样式）
src/style.css      样式
src/strings.json   多语言文案
scripts/package.ts 打包成 app.zip
```
"""


def main():
    ap = argparse.ArgumentParser(description="生成微应用项目脚手架")
    ap.add_argument("target", help="目标目录")
    ap.add_argument("--name", default="", help="应用名称（中文即可）")
    ap.add_argument("--id", dest="app_id", default="", help="应用 ID（UUIDv7）")
    args = ap.parse_args()

    target = os.path.abspath(args.target)
    if os.path.exists(target) and os.listdir(target):
        print("目标目录已存在且非空：" + target)
        return 1
    if not os.path.exists(TEMPLATE):
        print("找不到模板目录：" + TEMPLATE)
        return 1

    shutil.copytree(TEMPLATE, target, dirs_exist_ok=True)

    # 写 manifest
    manifest_path = os.path.join(target, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    if args.name:
        manifest["name"] = args.name
    if args.app_id:
        manifest["id"] = args.app_id
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    # 写 README
    app_name = args.name or manifest.get("name") or "微应用"
    with open(os.path.join(target, "README.md"), "w", encoding="utf-8") as f:
        f.write(README.format(name=app_name))

    print("已生成：" + target)
    print("  应用名：" + app_name)
    print("  应用 ID：" + manifest["id"] + ("（占位符，构建时需用 MINI_APP_ID 覆盖）"
                                          if not args.app_id else ""))
    print()
    if not args.app_id:
        print("⚠ 打包前置：先去拿应用 ID，再打包！")
        print("  1. 去社区个人资料的应用页创建应用，填好名称、说明和图标。")
        print("  2. 从应用页原样复制它分配的 UUIDv7，不要自己编。")
        print("  3. 构建时用 MINI_APP_ID=<应用ID> 传给打包流程，或写进 manifest.json 的 id。")
        print("  没拿到真实 ID 就跑打包，打包脚本会默认拒绝（占位 ID 上传必定 APP_ID_MISMATCH）。")
        print("  仅本地脚手架测试可用 --allow-placeholder / MINI_APP_ALLOW_PLACEHOLDER_ID=1 放行。")
        print()
    print("下一步：")
    print("  cd " + target)
    print("  bun install --frozen-lockfile")
    print("  MINI_APP_ID=<应用ID> MINI_APP_VERSION=1.0.0 bun run build")
    return 0


if __name__ == "__main__":
    sys.exit(main())
