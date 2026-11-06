---
name: mapp-developer
description: Build, debug and publish Discourse mini apps (社区微应用 / 微程序) for LinuxDo-style communities. This skill should be used when creating or modifying a mini app, editing manifest.json, wiring the @discourse-mini-app/sdk, declaring permissions/endpoints/websockets, packaging app.zip, or preparing a sandbox build for review. It also handles keeping the skill itself in sync with the upstream linux-do/mapp-developer-guide repository.
license: MIT
agent_created: true
allowed-tools:
---

# Discourse Mini App Developer

Build Discourse mini apps: a static bundle running inside the forum's mini-app
frame, using `@discourse-mini-app/sdk`, published as `app.zip`.

Rules come from `github.com/linux-do/mapp-developer-guide`. The guide changes;
treat the reference files as a cache and re-check upstream before relying on a limit.

## When to use

- Creating a new mini app or scaffolding a project from `assets/template/`
- Editing `manifest.json` — permissions, `assets`, `media`, `endpoints`, `websockets`,
  `remote_assets`
- Wiring the SDK: user, theme, storage, clipboard, media, HTTP, WebSocket
- Packaging `app.zip` and preparing a sandbox build
- Reviewing an app against the platform's submission rules
- Checking whether this skill is still current with the upstream guide

## Before you start

Run the upstream check before editing a manifest, building, or answering anything
that depends on a platform limit:

```bash
python3 scripts/evolve.py --evolve
```

It pulls upstream changes and updates the machine-readable rules. Non-zero means
the check failed or an update was rolled back — do not guess limits in that case.
For a read-only check use `sync_upstream.py --check`.
See [Upstream sync](#upstream-sync-the-skill-updates-itself).

Read the reference files after the check passes:

| File | Read it when |
| --- | --- |
| `references/manifest.md` | Editing `manifest.json` or declaring assets/endpoints |
| `references/sdk.md` | Using the SDK, permissions, theme, storage, media |
| `references/network.md` | Declaring HTTP/WebSocket endpoints or handling errors |
| `references/server-auth.md` | Building a backend that validates platform JWTs |
| `references/review.md` | Preparing a submission, or getting rejected |
| `references/upstream-notes.md` | Known upstream changes and their impact |

## 打包前置：先拿应用 ID，再谈打包

平台按 manifest 的 `id` 认应用。脚手架里的
`00000000-0000-7000-8000-000000000000` 是占位符，用它打包上传会报
`APP_ID_MISMATCH`。打包脚本对此设了硬门禁：

1. 去社区个人资料的应用页创建应用，填好名称、说明和图标。
2. 从应用页原样复制它分配的 UUIDv7（36 字符，形如 `xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx`），
   不要自己编、不要改其中任何一位。
3. 二选一交给打包流程：
   - 写进 `manifest.json` 的 `id` 字段；或
   - 构建时传环境变量：Bun 路径用 `MINI_APP_ID=<应用ID> bun run build`，
     Node 备用路径用 `MINI_APP_ID=<应用ID> node scripts/pack.mjs …`。
4. 再跑 `validate.mjs`，然后才能跑打包。

门禁规则（打包前先向用户确认 ID 已拿到）：
- `pack.mjs`（Node 备用路径）和模板的 `scripts/package.ts`（Bun 路径）：
  最终 `id` 仍是占位符时默认拒绝打包并退出，报错里会写明“先去应用页拿 ID”。
- `check_zip.mjs`：包内 `id` 是占位符时同样默认拒绝，旧包、绕过打包脚本的包
  也会在这里被拦下来。
- 唯一例外是纯本地脚手架测试：显式传 `--allow-placeholder`（或设
  `MINI_APP_ALLOW_PLACEHOLDER_ID=1`）才放行，且放行产物仍不能上传，
  只能用来验证布局和流程。
- `validate.mjs` 本身仍只对占位 ID 警告、不报错：因为校验常在开发中途跑，
  那时还没到打包那一步；真正拦人的关口是打包和验包。

助手的工作方式也按这个顺序：用户说“打包”时，先问一句 ID 拿到了吗、
拿到的是哪一个（让用户把应用页的 ID 贴出来或确认已写进 manifest），
没拿到就先停在拿 ID 这一步，不要先打一个占位包再事后补救。

## Workflow

### 0. Start from the template, not from scratch

`assets/template/` is a complete Bun + Vite + TypeScript project that builds a valid
`app.zip` with no configuration. It already contains the parts that are easy to get
wrong: the SDK adapter with graceful degradation, the `lifecycle.ready()` ordering,
a `strings.json` for localisation, and a packaging script.

Copy it rather than writing a project from memory — the platform's file-layout rules
(`index.html` as a fragment, five base files, declared assets) are enforced at upload,
not at build time.

### 1. Scaffold

```bash
python3 scripts/scaffold.py <project-dir>
```

Copies `assets/template/` — a Bun + Vite + TypeScript project that builds a valid
`app.zip` with zero configuration. The template has no hard-coded app ID: the ID comes
from `MINI_APP_ID` at build time, so the same source produces any app.

Keep the directory relationship to the SDK:

```text
my-app/
├── manifest.json
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── main.ts        # entry; calls sdk.lifecycle.ready()
│   ├── host.ts        # optional SDK adapter with graceful degradation
│   ├── template.html  # body fragment injected into index.html
│   └── style.css
└── scripts/package.ts # packs dist/web/* into app.zip
```

### 2. Write the manifest

`manifest.json` is the contract. Read `references/manifest.md` before editing it.

```json
{
  "format": 1,
  "id": "<app-id from the community app page>",
  "version": "1.0.0",
  "entry": "index.html",
  "script": "app.js",
  "style": "app.css",
  "permissions": ["user.read", "theme.read"]
}
```

Hard rules the platform enforces:

- `id` is a UUIDv7 assigned by the community — copy it, never invent one.
- `version` is exactly three numeric segments, no leading zeros, no suffix.
- `entry`/`script`/`style` are fixed to `index.html`/`app.js`/`app.css`.
- `permissions` are unique and from the known set only.
- Every file in the ZIP is either one of the five base files, or declared in `assets`/`media`.
- `index.html` is a **fragment**: no `<script>`, no inline `<style>`, no `on*` attributes.
- No secrets in the package.

### 3. Use the SDK

```ts
import { getSDK } from "@discourse-mini-app/sdk";

const sdk = getSDK();
await sdk.ready;
try {
  const user = sdk.permissions.has("user.read") ? await sdk.user.getCurrent() : null;
  // ... render ...
} finally {
  await sdk.lifecycle.ready();   // exactly once, after first render or a visible error
}
```

Non-negotiables:

- Call `sdk.lifecycle.ready()` exactly once — after the first render or after showing
  an error. Skipping it leaves a blank frame; calling it early hides real errors.
- Gate every capability on `sdk.permissions.has(...)`. Permission denial is normal, not
  exceptional: the app must still render.
- Anonymous sessions get `user === null` and no clipboard/HTTP/WS.
- Never touch the parent DOM, forum cookies, or another app's data.
- Handle `PERMISSION_DENIED`, `USER_CANCELLED`, `TIMEOUT`, `MESSAGE_LIMIT`, `APP_UNLOADED`.
- General call budget: 16 concurrent, 60 calls/minute.

`assets/template/src/host.ts` is a ready-made adapter that degrades gracefully —
use it rather than sprinkling permission checks through the UI.

### 4. Build and package

前提：上一步“先拿应用 ID”已经完成，`MINI_APP_ID` 是应用页原样复制来的
UUIDv7，不是占位符、不是自己编的。没拿到 ID 时不要跑下面任何一条，
打包脚本会直接拒绝。

```bash
cd my-app
bun install --frozen-lockfile
MINI_APP_ID=<app-id> MINI_APP_VERSION=1.0.0 bun run build
```

Output: `dist/package/app.zip`. Upload **only** that ZIP — never the project directory,
never the neighbouring `package.json`.

If Bun is unavailable, `scripts/pack.mjs` runs on plain Node (18+):

```bash
node scripts/pack.mjs manifest.json dist/web dist/package
node scripts/check_zip.mjs dist/package/app.zip
```

Note on the template dependency: `assets/template/package.json` depends on
`@discourse-mini-app/sdk` via `file:../../sdk`, which is only present if you
have the upstream repository checked out next to the skill. Without that
checkout, Bun build cannot resolve the SDK. In that case the supported
fallback is a plain-JS project (hand-written `index.html` fragment, `app.js`,
`app.css`, `strings.json`, plus declared `assets`/`media`), packaged with
`scripts/pack.mjs` + `scripts/check_zip.mjs` — no bundler, no SDK package
needed, because the platform installs the SDK globally before `app.js` runs
and the app reads it from the global the SDK documentation describes.

### 5. Validate before uploading

```bash
node scripts/validate.mjs <project-dir>
```

`validate.mjs` reimplements the platform's manifest checks locally — same rules, same
error wording as the upstream packer — so a rejection at upload is caught in a second
locally. It exits non-zero on any error. Run it before every upload and after every
manifest edit. Directory validation alone is not enough: after packing, always
validate the ZIP itself, because a packer bug can make the ZIP differ from the
directory (a real case: an older pack.mjs omitted `manifest.json` from the ZIP):

```bash
node scripts/check_zip.mjs dist/package/app.zip
```

`check_zip.mjs` also refuses a ZIP whose manifest id is still the scaffold
placeholder (unless `--allow-placeholder` is explicitly passed for a local-only
test build). A placeholder ZIP is not uploadable, however clean it looks.
`check_zip.mjs` checks that the ZIP file set matches the manifest exactly
(manifest + base files + declared assets + in-package media, remote media excluded),
that sizes are within limits, and then re-runs `validate.mjs` on the extracted
ZIP. A ZIP that fails `check_zip.mjs` is not uploadable, however clean the
source directory looks. `validate.mjs` also warns (not errors) when the id is
the scaffold placeholder `00000000-0000-7000-8000-000000000000`: that id is
syntactically a UUIDv7 but is not assigned to any app page, so uploading with
it always fails with `APP_ID_MISMATCH`.

### 6. Debug against the real platform

Local preview (`bun run dev`) exercises layout and business logic only — it installs no
fake SDK. Real capabilities require a sandbox build:

```bash
MINI_APP_ID=<app-id> MINI_APP_VERSION=1.0.1 bun run build:debug
```

Upload to the sandbox tab, then open DevTools and select the mini-app frame
(`/apps-sandbox/<app-id>/<version>-<8-char-sha>`). The sandbox keeps source maps;
the production build strips them.

### 7. Submit

Read `references/review.md`. The short version: upload the ZIP, wait for the sandbox to
build, create a release selecting the version and build, write the update notes, and
let the reviewer in. Sandbox builds expire after 7 days. A new release must have a
version higher than every previously published one. The same ZIP bytes with the same
SHA-256 is rejected as `BUILD_EXISTS` — change content or version and repackage.

## Common failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Upload rejected, `APP_ID_MISMATCH` | manifest `id` differs from the app page | Copy the ID from the community app page verbatim |
| Pack refused before any ZIP is made | manifest `id` is still the scaffold placeholder | Go to the community app page first, copy its UUIDv7, then rebuild — do not bypass the gate except for a local-only test with `--allow-placeholder` |
| `check_zip` refuses an existing ZIP | ZIP manifest `id` is still the placeholder | Same fix: get the real ID, rebuild, re-check; do not upload the placeholder ZIP |
| Upload rejected, `BUILD_EXISTS` | identical ZIP bytes submitted before | Change content or bump the version, then repackage |
| Blank frame, no error | `lifecycle.ready()` never called | Call it once after first render or after showing an error |
| Blank frame in preview only | Local preview has no SDK | Expected — test real behaviour in a sandbox build |
| Buttons do nothing | Capability gated behind an ungranted permission | Check `permissions.has()` and degrade visibly |
| HTTP 401 then silent failure | Protected endpoint needs `auth: "platform"` + JWT validation | See `references/server-auth.md` |
| Manifest too large | Data embedded in `manifest.json` | Move data to `assets`, read via `sdk.assets.readJson` |
| ZIP rejected for extra files | Undeclared file in the bundle | Declare it in `assets`/`media`, or drop it |

## Upstream sync: the skill updates itself

The guide upstream is the source of truth. This skill caches a snapshot of it.

### When to check

Run `scripts/sync_upstream.py --check` at these checkpoints, not just once at the start:

1. Before editing a manifest or declaring endpoints.
2. Before a build or packaging run.
3. When a platform error appears that the reference files do not explain.
4. When answering a question that turns on a numeric limit.
5. At the start of a session that will span more than a few minutes.

### What it does

`--check` fetches the upstream repository tree, compares commit SHA and per-file
content hashes against `references/upstream-snapshot.json`, and reports which upstream
files changed. It uses only `api.github.com` and `raw.githubusercontent.com`; when those
are unreachable it degrades to "unknown" rather than failing the task.

- Exit `0` and `UP TO DATE` → proceed with the reference files.
- Exit `2` and `UPDATE AVAILABLE` → the guide moved. Run
  `python3 scripts/sync_upstream.py --apply` to refresh `references/upstream-notes.md`
  and the snapshot, then re-read the affected reference file before continuing.
- Exit `1` and `CHECK FAILED` → the check itself could not run (network, rate limit).
  Proceed using the cached snapshot, and mention that the check could not run.

### Staying current: evolve.py does the machine-readable part automatically

`sync_upstream.py --apply` still only mirrors the upstream documents into
`references/upstream/` and regenerates `references/upstream-notes.md` — it does
not rewrite the derived reference files or the validator. That half-step is
exactly how a skill silently goes stale: the mirror is new, the rules you
actually build against are old.

`scripts/evolve.py` closes that gap for the rules that are machine-readable
and therefore safe to evolve without guessing at prose:

```
evolve ──► sync --check ──► CHECK FAILED? ──yes──► stop, change nothing, use cached snapshot
              │                                     (a failed check is never reported as "up to date")
              ▼ UPDATE?
         yes ──► sync --apply ──► parse upstream limits / permissions / MIME
              │                         │
              │                         ▼
              │                    drift? ──no──► log "no drift", done
              │                         │
              │                        yes
              │                         ▼
              │                    update validate.mjs constants
              │                    + references/manifest.md tables
              │                         │
              │                         ▼
              │                    run selftest ──► fail? ──► roll back, log failure, exit 1
              │                         │
              │                        pass
              │                         ▼
              │                    append references/upstream-changelog.md
              ▼
         no ──► evolve.py --check-local (offline, against the cached mirror)
```

What evolve.py auto-applies, and what it deliberately does not:

| Change | Auto-applied? | Where |
| --- | --- | --- |
| Numeric limits (manifest KiB, archive MiB, file count, endpoint count, URL/query/header sizes…) | Yes, with selftest + rollback | `LIMITS` in `validate.mjs` + limits table in `references/manifest.md` |
| Permission names (from `sdk/index.d.ts` Permission type) | Yes, with selftest + rollback | `PERMISSIONS` in `validate.mjs` + permission block in `references/manifest.md` |
| Remote MIME set (from the upstream remote-assets table) | Yes, with selftest + rollback | `REMOTE_MIMES` in `validate.mjs` |
| SDK methods, error codes, auth rules, submission rules, prose | No — reported as pending in the changelog | Human (or a later, reviewed run) updates `references/sdk.md` / `network.md` / `review.md` |

A formatting-only upstream change (same numbers, same permissions, different
wording) is correctly reported as "no drift": evolve.py compares parsed rules,
not file hashes, so it does not cry wolf over a reworded paragraph. Conversely,
a hash change with no rule change still leaves `upstream-notes.md` from
`sync --apply` for a human to skim, but it does not trigger a validator rewrite.

`evolve.py --check-local` works fully offline against the cached mirror in
`references/upstream/` — use it when the network check fails, to prove the
validator still matches the last known upstream rules, rather than assuming it.

### The self-evolution loop (manual part, for non-machine-readable changes)

For prose, auth, and submission changes that evolve.py only reports:

**What must be updated when upstream moves:**

| Upstream change | Where to update |
| --- | --- |
| Numeric limits (64 KiB manifest, 32 MiB archive, 16 endpoints…) | `references/manifest.md` + `LIMITS` in `scripts/validate.mjs` |
| Permission names | `references/manifest.md` + `PERMISSIONS` in `scripts/validate.mjs` |
| SDK methods or fields | `references/sdk.md` |
| Error codes | `references/sdk.md` + `references/network.md` |
| Endpoint or auth rules | `references/network.md` + `scripts/validate.mjs` |
| Submission rules | `references/review.md` |

**After changing `validate.mjs`, cross-check it against the upstream packer.** The
official `pack()` from `@discourse-mini-app/sdk/pack` is the ground truth. Build a
matrix of deliberately broken manifests, run both, and confirm they agree on every
case. A local validator that disagrees with the platform is worse than none — it
either blocks valid apps or lets broken ones through.

```ts
// 一致性自检骨架
import { pack } from "@discourse-mini-app/sdk/pack";
const cases = [ /* 每项是 {label, manifest 补丁} */ ];
for (const [label, patch] of cases) {
  try { await pack({ manifest: {...base, ...patch}, files }); console.log(label, "PASS"); }
  catch (e) { console.log(label, "FAIL", e.message); }
}
```

Run the same matrix through `scripts/validate.mjs` and compare verdicts. They must
match case for case.

### Schedule

The check is time-based as well as event-based. `references/upstream-snapshot.json`
records `checkedAt`; when it is older than 14 days the check reports
`STALE` and asks for a refresh even if nothing else triggered it.

## Privacy

No user paths, personal identifiers or project data. `references/upstream/` is a
regenerable mirror of public docs. The audit covers every text file — LICENSE,
shell scripts, upstream mirror — and exempts only the two scripts holding the
detection regex literals. Never add specific names to the audit scripts.

## Installation

Copy this directory into `~/.workbuddy/skills/mapp-developer/` or
`<project>/.workbuddy/skills/mapp-developer/`. See README for the agent install
prompt. Requires Node 18+ and Python 3.8+; Bun 1.2+ is optional.

## Distribution

`bash scripts/package.sh` audits and builds the zip (top-level
`mapp-developer-skill/` intact). `python3 scripts/selftest.py` verifies the skill;
run it after editing any script or reference file.
