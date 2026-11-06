# SDK API 参考

包名 `@discourse-mini-app/sdk`。`getSDK()` 返回 SDK 实例，
等待 `sdk.ready` 后调用 API。完成首次渲染或显示错误后调用 `lifecycle.ready()`。

```ts
import { getSDK } from "@discourse-mini-app/sdk";

const sdk = getSDK();
await sdk.ready;
try {
  const user = sdk.permissions.has("user.read") ? await sdk.user.getCurrent() : null;
  // 渲染
} finally {
  await sdk.lifecycle.ready();
}
```

SDK 由平台在应用脚本执行前安装。全局 `miniApp` 存在则说明跑在平台里，
否则抛 `Run this app inside the Discourse mini-app loader`。

## 权限与方法对照

| 权限 | 方法 |
| --- | --- |
| `user.read` | `user.getCurrent()` |
| `user.lookup` | `user.getById(userId)` |
| `launch.read` | `launch.getParameters()` |
| `theme.read` | `theme.get()`、`theme.onChange(cb)` |
| `storage.read` / `storage.write` | `localStorage.getItem/setItem/removeItem/clear` |
| `cookies.read` / `cookies.write` | `cookies.get/set/remove` |
| `clipboard.read` / `clipboard.write` | `clipboard.readText/writeText` |
| `fullscreen` | `fullscreen.request/exit` |
| `audio.play` / `video.play` | `audio.play(assetId)`、`video.play(assetId)`、对应 `stop(handle)` |
| `network.request` | `http.request(endpointName, options)` |
| `network.websocket` | `webSocket.connect(endpointName, options)` |
| `assets.remote` | `assets.readBytes/readText/readJson(path)` 读声明的 CDN 素材 |

## 生命周期

```ts
await sdk.ready;              // 通信通道连接完成
await sdk.lifecycle.ready();  // 首次渲染或已显示错误后调用一次
```

`lifecycle.ready()` **只能调一次**。不调 → 框架一直显示空白；
过早调 → 真实错误被隐藏，来不及呈现给用户。

低层 RPC `sdk.request(method, params)` 存在，但优先用具名方法。

## 用户

```ts
const user = await sdk.user.getCurrent();   // 访客为 null
const other = await sdk.user.getById(id);    // 需要 user.lookup
```

字段：`id` / `username` / `name` / `initials` / `trustLevel` / `avatarUrl`。

- `id` 用于关联用户数据与判断身份；`username` 只用于展示。
- `trustLevel` 是论坛信任等级 0–4，未提供时为 `null`。
  它是**展示信息，不是开发者服务器的授权凭据**。
- `avatarUrl` 是请求 288 像素头像后得到的**本次运行内** Blob URL，
  可直接设给 `img.src`。读取失败、头像缺失或资源预算用尽时为 `null`，
  可回退显示 `initials`。
- 不要持久化或手动回收 `avatarUrl`；离开微应用后失效。
- 每次运行最多保留 128 张头像、合计 8 MiB，单张最多 256 KiB。
- 支持 PNG / JPEG / GIF / WebP / AVIF，其他格式返回 `null`。

## 启动参数

```ts
const { query, hash } = await sdk.launch.getParameters();
```

- `query` 是 `Record<string, string[]>`，重复 query 保留全部值。
- `hash` 是去掉 `#` 的编码片段。
- 总量最多 8 KiB。**不能作为身份凭据**。快照不会更新。

## 主题

```ts
const { mode, background, text, accent, border, locale, reducedMotion, viewport }
  = await sdk.theme.get();

const unsubscribe = sdk.theme.onChange(({ locale }) => updateLanguage(locale));
```

- `mode` 为 `"light"` / `"dark"`。
- `locale` 沿用 Discourse 语言代码，如 `zh_CN`、`zh_TW`、`en`。
- `reducedMotion` 指示用户是否要求减少动效 —— 应当尊重它。
- `viewport` 是 `{ width, height }`。
- `onChange` 返回取消订阅函数；离开时调用它。

## 存储

```ts
await sdk.localStorage.setItem("progress", JSON.stringify({ level: 2 }));
const raw = await sdk.localStorage.getItem("progress");
```

- 仅保存在当前浏览器，按应用且**正式/沙盒隔离**。
- `clear()` 只清当前应用范围。
- 数据不跨设备同步；切换账号不会自动切换此应用的数据。
- key 长度 1–80 字符，单值最多 4 KiB，每环境最多 64 个键、64 KiB。
- key 与 value 会被强制转成字符串（同浏览器 Storage API 行为）。
- 浏览器拒绝存储时返回 `STORAGE_UNAVAILABLE` —— 要处理保存失败。

## Cookie

```ts
await sdk.cookies.set("name", "value", { maxAge: 3600 });
const v = await sdk.cookies.get("name");
await sdk.cookies.remove("name");
```

- 同样按应用及正式/沙盒隔离。
- key 限字母、数字、点、下划线、连字符。
- `maxAge` 单位秒，默认一天，最长 30 天，`0` 表示删除。
- 当前范围最多 32 项、总量 4 KiB。

## 剪贴板 / 全屏

```ts
await sdk.clipboard.writeText("...");
const text = await sdk.clipboard.readText();   // 需 clipboard.read
await sdk.fullscreen.request();
await sdk.fullscreen.exit();
```

剪贴板文字最多 4 KiB。剪贴板、全屏、媒体播放都按平台提示由用户确认。

## 媒体播放

```ts
const { handle } = await sdk.audio.play("chime", { volume: 0.5, loop: true });
await sdk.audio.stop(handle);
const v = await sdk.video.play("intro");
await sdk.video.stop(v.handle);
```

- 只播放 manifest 声明的包内资源或固定 CDN 素材。
- 远程媒体同时需要 `assets.remote` 和对应播放权限。

## 包内文件读取

读取只限当前包的基础文件和已声明资源，**不需要额外权限**。三个方法都是异步：

```ts
const text = await sdk.assets.readText("data/settings.json");
const json = await sdk.assets.readJson("strings.json");
const bytes = await sdk.assets.readBytes("images/logo.png");
```

包内图片用 Blob：

```ts
const bytes = await sdk.assets.readBytes("images/logo.png");
const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
img.src = url;
// 不再使用时：URL.revokeObjectURL(url)
```

包内单文件最多 8 MiB。

## CDN 素材读取

```ts
if (sdk.permissions.has("assets.remote")) {
  const bytes = await sdk.assets.readBytes("images/atlas.webp");
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
}
```

- 只传已声明的虚拟路径，不能传任意 URL。
- 相同文件的并发读取会合并；只在每次下载后校验一次，缓存命中复用已验证结果。
- 远程读取的 SDK 调用期限 45 秒（含排队）；远程音视频播放 105 秒。
- 常见错误：`ASSET_NOT_FOUND`、`PERMISSION_DENIED`、`REMOTE_ASSET_FAILED`、
  `REMOTE_ASSET_INVALID`、`RATE_LIMIT`、`APP_UNLOADED`。
- 校验失败**没有**忽略 SHA-256 的回退。

## HTTP

```ts
const response = await sdk.http.request("createMessage", {
  query: { room: "lobby" },
  json: { text: "Hello" },
});
// response = { status, headers, body }
```

- 方法由 manifest 固定；可选 `method` 必须与声明一致。
- GET 无正文；JSON 正文最多 4 KiB。
- 响应 JSON 最多 64 KiB，空正文为 `null`。
- HTTP 总截止 5 秒。
- 调用者不能覆盖 URL、固定 query 或 headers。

## WebSocket

```ts
const connection = await sdk.webSocket.connect("events", { query: { room: "lobby" } });

const off = connection.on("message", showMessage);
connection.on("error", ({ code }) => showError(code));
connection.on("close", ({ code }) => showClosed(code));

await connection.send({ type: "join" });

// 离开该功能时：
await connection.close();
off();
```

- `on` 支持 `message` / `error` / `close`，返回取消订阅函数。
- 连接就绪后立即订阅消息。
- JSON 每条最多 4 KiB、32 层，收发各 30 条/秒。

## 调用预算与错误

一般调用最多 16 并发、60 次/分钟。

必须处理的错误码：

| 错误码 | 含义 |
| --- | --- |
| `PERMISSION_DENIED` | 权限未获批 |
| `ACCESS_DENIED` | 业务权限不足 |
| `INVALID_ARGUMENTS` | 参数不合法 |
| `USER_CANCELLED` | 用户取消（剪贴板、全屏、播放确认） |
| `RATE_LIMIT` | 超出速率限制 |
| `MESSAGE_LIMIT` | 单条消息超限 |
| `BACKPRESSURE` | 发送队列拥塞 |
| `TIMEOUT` | 超时 |
| `SOCKET_CLOSED` | 连接关闭 |
| `APP_UNLOADED` | 应用已卸载 |
| `STORAGE_UNAVAILABLE` | 浏览器拒绝存储 |

**不要改用原生网络 API**（`fetch` / `XMLHttpRequest` / `WebSocket`）绕过这些限制。

## 匿名模式

匿名（未登录）会话：

- `user.getCurrent()` 返回 `null`
- 不能查询其他用户（`user.lookup`）
- 不能用剪贴板
- 没有通用 HTTP/WS 权限
- 已获批的固定 CDN 素材仍可读取

已登录的嵌入页按同样的应用权限使用这些接口。
