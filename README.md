# mapp-developer

Discourse 微应用开发 skill。规则取自 [linux-do/mapp-developer-guide](https://github.com/linux-do/mapp-developer-guide)。

## Agent 安装

把下面这段发给 Agent：

```text
安装 mapp-developer skill：
下载 https://github.com/superzhang21/mapp-developer-skill/releases/latest/download/mapp-developer-skill.zip
解压后把 mapp-developer-skill/ 整个目录放到 ~/.workbuddy/skills/ 下
（项目级放 <项目>/.workbuddy/skills/）。
然后跑 python3 scripts/selftest.py，全部通过再结束。
```

手动装同理：`mapp-developer-skill/` 放进 skills 目录。
Windows 用户级是 `%USERPROFILE%\.workbuddy\skills\mapp-developer\`。

## Agent 使用

装好后直接说需求：「建一个微应用」「改 manifest 权限」「打包提审」。
Agent 读 `SKILL.md` 走流程。三个硬要求：

1. 应用 ID 去社区应用页创建后复制 UUIDv7，不要自己编。
2. 动手前跑 `evolve.py --evolve`，确认上游规则没变。
3. 上传前验目录，打包后再验包本身。

```bash
python3 scripts/scaffold.py my-app --name "我的应用"
python3 scripts/evolve.py --evolve
node scripts/validate.mjs my-app
node scripts/pack.mjs manifest.json dist/web dist/package
node scripts/check_zip.mjs dist/package/app.zip
```

## 维护

上游规范会变。`evolve.py --evolve` 自动更新限额、权限名、MIME 等机器可读规则；
措辞、鉴权、提审的变化只记进 `references/upstream-changelog.md`，需人工判断。
`references/upstream/` 是上游文档镜像，可删。

改过脚本或参考文档后跑 `python3 scripts/selftest.py`。
对外分发用 `bash scripts/package.sh`，先脱敏审计再打包。

## 依赖

Node 18+、Python 3.8+。Bun 1.2+ 可选，仅模板构建用。

## 许可

MIT。上游规范与 SDK 版权归 linux-do/mapp-developer-guide 及其作者所有。
