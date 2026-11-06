# manifest.json 规格

`manifest.json` 是微应用与平台之间的唯一契约。平台在上传时逐字段校验，
任何一条不满足都会让整个 ZIP 被拒。

## 完整字段

```json
{
  "format": 1,
  "id": "019a2a58-0000-7000-8000-000000000001",
  "name": "应用名称",
  "version": "1.0.0",
  "entry": "index.html",
  "script": "app.js",
  "style": "app.css",
  "permissions": ["user.read", "theme.read"],
  "assets": ["data/settings.json", "images/logo.png"],
  "media": {
    "chime": { "path": "media/chime.wav", "kind": "audio", "mime": "audio/wav" }
  },
  "endpoints": {
    "createMessage": {
      "url": "https://api.example.com/messages",
      "method": "POST",
      "query": ["room"],
      "headers": { "X-App": "demo" },
      "auth": "platform"
    }
  },
  "websockets": {
    "events": {
      "url": "wss://api.example.com/events",
      "query": ["room"],
      "protocols": ["json.v1"],
      "auth": "platform"
    }
  },
  "remote_assets": {
    "images/atlas.webp": {
      "url": "https://cdn.example.com/game/v1/atlas.webp",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "size": 10485760,
      "mime": "image/webp"
    }
  }
}
```

## 逐字段规则

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `format` | 是 | 固定为 `1` |
| `id` | 是 | 社区应用页面分配的 UUIDv7，36 字符，格式 `xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx`。**原样复制，不可自行生成** |
| `version` | 是 | 三段纯数字 `x.y.z`，无前导零、无后缀、无空白，最长 64 字符 |
| `entry` | 是 | 固定 `"index.html"` |
| `script` | 是 | 固定 `"app.js"` |
| `style` | 是 | 固定 `"app.css"` |
| `permissions` | 是 | 数组，元素不得重复，取值见下表 |
| `name` | 否 | 显示名 |
| `assets` | 否 | 包内普通资源路径数组 |
| `media` | 否 | 音视频声明 |
| `endpoints` | 否 | HTTP 端点，最多 16 个 |
| `websockets` | 否 | WS 端点，最多 16 个 |
| `remote_assets` | 否 | 固定 CDN 素材清单 |

### 权限全集

```
user.read           user.lookup         launch.read         theme.read
storage.read        storage.write       cookies.read        cookies.write
clipboard.read      clipboard.write     fullscreen          audio.play
video.play          assets.remote       network.request     network.websocket
```

只申请实际用得到的权限 —— 审核时每项权限都要说明用途。

## 限额

| 项目 | 限额 |
| --- | --- |
| manifest JSON | 64 KiB，最多 32 层嵌套 |
| ZIP 文件数 | 128 |
| 解压后总量 | 32 MiB |
| 单文件 | 8 MiB |
| 媒体数 | 16 |
| 文件路径 | 160 字节 ASCII，无空段、无 `.` / `..` |
| HTTP 端点 / WS 端点 | 各最多 16 |
| 端点 URL | 2048 字节 |
| 动态 query | 最多 16 项，每值最多 200 UTF-8 字节 |
| HTTP 常量 headers | 最多 16 项；名称 64 字符，值 256 字节 |
| WS 子协议 | 最多 8 项 |

## ZIP 内容

五个基础文件必须位于根目录：

```text
manifest.json
index.html
app.js
app.css
strings.json
```

其余文件必须在 `assets`（普通资源）或 `media`（音视频）中声明。
未声明的文件、目录项、符号链接、重复路径、越界路径一律拒绝。

`index.html` 是**正文片段**，不是完整文档：

- 不带 `<script src>` 入口（脚本由 manifest 的 `script` 字段注入）
- 不带内联 `<style>`
- 不带 `onclick` 等事件属性
- 用 `addEventListener` + `textContent` + CSS 类写界面

目前不支持动态分包、外部脚本、字体加载。包内图片经 SDK 读取后以 Blob 加载。

## 打包器会额外检查的事

- 大数据文件内联进 `manifest.json` 或首屏 → `Startup content is too large`。
  大数据放 `assets`，运行时用 `sdk.assets.readJson()` 读。
- `strings.json` 必须是合法 JSON。
- 打包产物同时生成 `app.zip` 和一份不含机密的 `package.json`（构建元数据）。
- 路径不能是 `__proto__` / `constructor` / `prototype`。

## 同一 ZIP 的 SHA-256 即构建身份

同一应用中，原始 ZIP 的 SHA-256 相同就视为同一构建，重复提交直接拒绝
（`BUILD_EXISTS`），已过期也不例外。临时处理失败请重试原记录；
要更新或重新测试过期构建，**必须修改内容或版本号后重新打包**。

## 版本号策略

- 沙箱：同一版本号可上传多个构建，用于反复测试。
- 正式：新发布版本必须**高于**历史最高正式版本。
- 历史正式版可重新上线做回滚，但不能替换内容。
- 被永久锁定的版本不能修改、删除重建、重新提审或激活。

## remote_assets（开发者 CDN 素材）

把图片、音频、视频、JSON、二进制放在自己有权运营的 CDN，按需读取，
不进 ZIP。需要 `assets.remote` 权限。

- 键是 SDK 使用的**虚拟路径**，不是 URL。遵循包内路径规则，不能与基础文件、
  包内文件或 `assets` 列表重名。
- 每项只能有 `url`、`sha256`、`size`、`mime` 四个字段。
  - `sha256`：实际文件 64 位小写十六进制 SHA-256（对下载后字节计算）
  - `size`：实际字节数，≤ 32 MiB
  - `mime`：见下表
- URL 要求：HTTPS 默认 443 端口、公开 CDN 域名；不含账号密码、片段、反斜杠、
  相对路径段、IP、`localhost`、`.local`、`.internal`；固定 query 可写在 URL 里，
  但不能用 `mini_app_token`；调用时不能再加 query、正文或请求头。
- CDN 必须允许论坛 origin 的 CORS GET，origin 不含论坛子目录。
  不依赖重定向、Cookie、Authorization 或短期登录链接。
- 保持同一 URL 的字节稳定，优先用带版本或内容哈希的 URL，
  不覆盖旧版本仍引用的素材。关闭自动转码、按设备返回不同格式等功能。
- 远程音视频仍要在 `media` 中声明，`path` 指向远程键，MIME 必须完全相同；
  此时不要把对应文件打进 ZIP。
- 远程素材**不提供**脚本/HTML/CSS 的加载执行能力。改内容或地址后要更新清单、
  建新版本、重新提审。

支持的远程 MIME：

```
image/png  image/jpeg  image/gif  image/webp  image/avif
audio/wav  audio/mpeg  audio/ogg
video/mp4  video/webm
application/json  application/octet-stream
```

远程素材限额：清单 128 项、单文件 32 MiB、全清单 256 MiB、并发下载 2 个、
单次下载 30 秒、当前实例已验证缓存 64 MiB。SDK 调用期限 45 秒（含排队），
远程音视频播放 105 秒（含下载与用户确认）。

## media（包内音视频）

```json
"media": {
  "chime":  { "path": "media/chime.wav", "kind": "audio", "mime": "audio/wav" },
  "intro":  { "path": "media/intro.mp4", "kind": "video", "mime": "video/mp4" }
}
```

- 路径必须匹配 `media/[A-Za-z0-9_-]+\.[a-z0-9]+`
- MIME 仅支持 `audio/wav`、`audio/mpeg`、`audio/ogg`、`video/mp4`、`video/webm`
- 仅播放，不支持流式或 HLS/DASH

## 端点声明

```json
"endpoints": {
  "createMessage": {
    "url": "https://api.example.com/messages",
    "method": "POST",
    "query": ["room"],
    "headers": { "X-App": "demo" },
    "auth": "platform"
  }
}
```

- `method` 必填，取 `GET` / `POST` / `PUT` / `PATCH` / `DELETE`。GET 无正文。
- `auth`：`"none"`（公开 HTTP）或 `"platform"`（受保护）。
  **所有 WebSocket 端点必须是 `platform`**，否则打包报错。
- `query`：列出允许运行时传入的动态 query 参数名，最多 16 项。
- `headers`：审核过的常量头。禁止敏感头与传输头：
  `authorization`、`proxy-authorization`、`cookie`、`set-cookie`、`origin`、`referer`、
  `connection`、`upgrade`、`content-length`、`transfer-encoding`、`content-type`、
  `accept-encoding`、`forwarded`、`x-real-ip`。
- WebSocket **不能**声明 headers；子协议用 `protocols`（最多 8 项），
  不支持自定义握手头。
- URL 必须是 `https:`（WS 用 `wss:`）、默认 443 端口、无凭据、无片段、
  无反斜杠、无 `.`/`..` 路径段。

`auth: "platform"` 需要同时申请 `user.read` 权限。
`mini_app_token` 是保留参数，不能声明也不能出现在 URL 里。

## 资源路径写法

`assets` 里的路径遵循包内路径规则：160 字节 ASCII，
`[a-zA-Z0-9_.\-/]` 组成，斜杠分段不得为空、不得为 `.` 或 `..`。

Vite 项目里把普通资源放 `public/`，例如 `public/data/settings.json`，
在 manifest 的 `assets` 中写 `data/settings.json`，构建会把它打进 ZIP。
