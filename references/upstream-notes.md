# 上游变更记录

由 `scripts/sync_upstream.py --apply` 自动生成。
`references/upstream/` 下是**原始上游文档的镜像**，用于判断本地参考文档是否需要跟进。

- 上游仓库：`linux-do/mapp-developer-guide`
- 上游 commit：`（API 限流，未取到）`
- 提交时间：—
- 本次同步：2026-11-03T11:33:14+00:00

## 本次变化

- **已修改** `docs/sdk-network.md` → 需检查并更新 `references/network.md`

## 全部关注文件

| 上游文件 | 本次状态 | 对应参考文档 |
| --- | --- | --- |
| `README.md` | 未变 | `—` |
| `docs/developer-guide.md` | 未变 | `references/manifest.md` |
| `docs/sdk-network.md` | 已修改 | `references/network.md` |
| `docs/server-auth.md` | 未变 | `references/server-auth.md` |
| `docs/submission-review.md` | 未变 | `references/review.md` |
| `sdk/README.md` | 未变 | `references/sdk.md` |
| `sdk/index.d.ts` | 未变 | `references/sdk.md` |
| `sdk/pack.d.ts` | 未变 | `—` |
| `sdk/package.json` | 未变 | `—` |
| `sdk/server.d.ts` | 未变 | `—` |

## 下一步

1. 读 `references/upstream/` 下对应的镜像文件，与本地 `references/*.md` 逐条比对。
2. 把上游新增或修改的规则**补进**对应参考文档 —— 参考文档是提炼物，上游是原文，不要整篇覆盖。
3. 若限额、权限名、错误码有变，同步更新 `scripts/validate.mjs` 的常量。
4. 若 `sdk/index.d.ts` 变了，核对 `references/sdk.md` 的方法表是否仍准确。
5. 在本文件末尾追加一行本次更新摘要。
