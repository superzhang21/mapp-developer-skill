# mapp-developer

Discourse 微应用（社区微程序）开发技能。基于
[`linux-do/mapp-developer-guide`](https://github.com/linux-do/mapp-developer-guide) 提炼，
带**上游自动同步**能力 —— 官方规范更新了，技能会自己发现并跟进。

## 安装

把整个目录放到技能目录下：

| 作用域 | 路径 |
| --- | --- |
| Muse（本机） | `~/workspace/custom-skills/mapp-developer/` |
| 用户级（跨项目可用） | `~/.workbuddy/skills/mapp-developer/` |
| 项目级（团队共享） | `<项目>/.workbuddy/skills/mapp-developer/` |

Windows 用户级路径通常是 `C:\Users\<用户名>\.workbuddy\skills\mapp-developer\`。

## 目录结构

```text
mapp-developer/
├── SKILL.md                      入口：工作流与触发规则
├── references/
│   ├── manifest.md               manifest 规格、限额、端点与素材声明
│   ├── sdk.md                    SDK API、权限、错误码
│   ├── network.md                HTTP/WebSocket 端点规范
│   ├── server-auth.md            服务端 JWT 验签
│   ├── review.md                 提审流程与自查清单
│   ├── upstream-notes.md         上游变更记录（自动生成）
│   ├── upstream-snapshot.json    上游快照（自动生成）
│   └── upstream/                 上游文档镜像（自动生成，可删）
├── scripts/
│   ├── sync_upstream.py          上游检查与同步
│   ├── validate.mjs              manifest 离线预检
│   ├── pack.mjs                  无 Bun 时的打包替代
│   ├── scaffold.py               项目脚手架
│   ├── selftest.py               技能自身自检
│   └── package.sh                脱敏审计 + 打包分发
└── assets/template/              可直接构建的 Bun + Vite 项目模板
```

## 自检

```bash
python3 scripts/selftest.py
```

验证目录结构、脚本语法、校验器行为（合法通过、六类错误全部拒绝）、
脚手架产物、以及脱敏。改动任何脚本或参考文档后都该跑一遍。

## 打包分发

```bash
bash scripts/package.sh [输出目录]
```

先跑脱敏审计与语法自检，通过后生成 `mapp-developer-skill.zip`。
审计会拦截本地路径、个人标识、项目名与疑似密钥 —— 不通过就拒绝打包。

## 用法

```bash
# 第 0 步：先拿应用 ID，再打包（必做）
# 去社区个人资料的应用页创建应用，填好名称、说明和图标，
# 从应用页原样复制它分配的 UUIDv7，不要自己编。
# 打包时用 MINI_APP_ID=<应用ID> 传给打包流程，或写进 manifest.json 的 id。
# 模板自带的占位 ID 打包脚本默认拒绝，验包脚本同样拒绝，
# 仅本地脚手架测试可用 --allow-placeholder / MINI_APP_ALLOW_PLACEHOLDER_ID=1 放行。

# 生成项目
python3 scripts/scaffold.py my-app --name "我的应用"

# 校验 manifest（上传前必跑）
node scripts/validate.mjs my-app

# 打包后必须再验包本身（目录过不等于包过，见下）
node scripts/pack.mjs manifest.json dist/web dist/package
node scripts/check_zip.mjs dist/package/app.zip

# 上游进化：一键检查 + 有更新时自动进化机器可读规则
python3 scripts/evolve.py --evolve

# 只比对本地镜像与校验器（离线可用，不改文件）
python3 scripts/evolve.py --check-local

# 低层命令：只检查 / 只拉镜像 / 只看快照
python3 scripts/sync_upstream.py --check
python3 scripts/sync_upstream.py --apply
python3 scripts/sync_upstream.py --status
```

## 上游同步机制

上游仓库不定期更新，规范里的限额、权限名、错误码都可能变。这个技能用两层机制跟进：

**第一层 —— 自动检查。** `sync_upstream.py --check` 并发探测多个内容源，
取回 10 个关注文件的当前内容，与 `references/upstream-snapshot.json` 里的哈希比对。

| 退出码 | 含义 | 该做什么 |
| --- | --- | --- |
| 0 | UP TO DATE | 继续用本地参考文档 |
| 2 | UPDATE AVAILABLE | 跑 `--apply`，然后读 `references/upstream-notes.md` |
| 1 | CHECK FAILED | 网络不通，本地快照仍可用，但涉及限额的问题需人工确认 |

**第二层 —— 人工提炼。** `--apply` 只做两件事：把上游原文镜像到
`references/upstream/`，以及生成一份变更清单。它**不会**自动改写
`references/*.md` —— 那些是提炼物，规则的语义需要判断，盲目覆盖会丢掉积累的细节。

**时效。** 快照记录 `checkedAt`，超过 14 天检查会额外报 `STALE`，
即使内容没变也会提醒刷新。快照和镜像是可再生缓存，删掉不影响使用。

**内容源。** 默认顺序为 `raw.githubusercontent.com` → `ghfast.top` 镜像 →
`ghproxy.net` 镜像。脚本并发探测，按实测延迟选最快的那个；全部不可达时
报「无法判定」而不是假装上游没更新。

## 打包产物校验

`validate.mjs` 只看目录，`pack.mjs` 的产物可能和目录不一致。
旧版 `pack.mjs` 曾漏打 `manifest.json`，目录全过、包却缺契约。
所以打包流程固定是两步：先 `validate.mjs`，再 `check_zip.mjs`，
后者校验包内文件集合与 manifest 完全一致（manifest + 基础文件 +
声明的 assets + 包内 media，远程媒体除外），并解压后重跑一遍
`validate.mjs`。`check_zip.mjs` 没过，包就不算可上传。

模板的 `scripts/package.ts`（SDK 打包路径）同样修过：旧版只打了
assets、漏了包内 media，现版已补上；`manifest.json` 本身由 SDK
的 pack 写进包，无需在 files 里重复写（无 SDK 的 `pack.mjs`
则必须显式写，见其注释）。

## 自动进化

`evolve.py` 是上游同步的自动进化层：它解析上游限额表、权限类型、
远程 MIME 表，与 `validate.mjs` 的常量和 `references/manifest.md`
的限额表比对；有漂移就自动更新校验器与参考表、跑自检、失败回滚、
把结果追加到 `references/upstream-changelog.md`。措辞、鉴权、提审等
语义变化它不自动改，只记在日志里待人工复核；纯排版变化会正确报
“无漂移”，不会因为文件哈希变了就乱改规则。网络不通时它什么都不改，
绝不把“检查失败”说成“上游没变”。

## 校验器

`validate.mjs` 复刻了上游 `@discourse-mini-app/sdk/pack` 的全部 manifest 校验规则，
错误措辞也对齐上游。它跑在本地、零依赖、秒级返回 —— 上传被拒的问题在本地就暴露。

已用 24 组错误用例与上游官方 packer 交叉验证，判定结果**完全一致**（0 分歧）。

```bash
node scripts/validate.mjs my-app           # 人类可读
node scripts/validate.mjs my-app --json    # JSON 输出
node scripts/validate.mjs --manifest m.json
```

## 依赖

| 组件 | 要求 | 缺失时 |
| --- | --- | --- |
| Node.js | 18+ | 必需，`validate.mjs` / `pack.mjs` 依赖 |
| Python | 3.8+ | 必需，`sync_upstream.py` / `scaffold.py` 依赖 |
| Bun | 1.2+ | 可选，用 `scripts/pack.mjs` 替代打包 |

## 隐私

本目录不含任何用户路径、个人标识符或项目数据。`references/upstream/` 是上游公开
文档的镜像，可以随时删除并在下次 `--apply` 时重建。

脱敏检查是通用模式：拦绝对路径、真实形态的邮箱、手机号、密钥，
不含任何具体人名或项目名的黑名单——把具体名字写进检查脚本，
反而会把那个名字永远带进分发的 skill 里。需要核对某个具体名字时，
请在本地另外核对，不要把它加进 skill。`evolve.py` 只读写本 skill
目录内的文件和上游公开文档，不读、不发任何用户数据。

## 许可

MIT。上游规范与 SDK 版权归 `linux-do/mapp-developer-guide` 及其作者所有。
