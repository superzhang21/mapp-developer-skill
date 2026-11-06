#!/usr/bin/env node
/**
 * manifest.json 离线预检，规则与错误措辞对齐上游 sdk/pack。
 *
 *   node validate.mjs <项目目录> [--json]
 *   node validate.mjs --manifest path.json
 *
 * 退出码：0 通过 / 1 有错误 / 2 用法错误
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------- 上游常量

const PERMISSIONS = new Set([
  "user.read", "user.lookup", "launch.read", "theme.read",
  "storage.read", "storage.write", "cookies.read", "cookies.write",
  "clipboard.read", "clipboard.write", "fullscreen",
  "audio.play", "video.play", "assets.remote",
  "network.request", "network.websocket",
]);

const MEDIA_MIMES = new Set(["audio/wav", "audio/mpeg", "audio/ogg", "video/mp4", "video/webm"]);

const REMOTE_MIMES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "audio/wav", "audio/mpeg", "audio/ogg",
  "video/mp4", "video/webm",
  "application/json", "application/octet-stream",
]);

const SENSITIVE_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie",
  "origin", "referer", "connection", "upgrade",
  "content-length", "transfer-encoding", "content-type",
  "accept-encoding", "forwarded", "x-real-ip",
]);

const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const BASE_FILES = ["manifest.json", "index.html", "app.js", "app.css", "strings.json"];

const LIMITS = {
  manifestBytes: 64 * 1024,
  fileCount: 128,
  expandedBytes: 32 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  mediaCount: 16,
  pathLength: 160,
  endpointCount: 16,
  urlBytes: 2048,
  queryCount: 16,
  queryValueBytes: 200,
  headerCount: 16,
  headerNameLength: 64,
  headerValueBytes: 256,
  protocolCount: 8,
  remoteAssetCount: 128,
  remoteAssetBytes: 32 * 1024 * 1024,
  remoteAssetTotalBytes: 256 * 1024 * 1024,
};

// ---------------------------------------------------------------- 工具

const errors = [];
const warnings = [];

function err(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

/** 上游的包内路径规则：ASCII 字母数字下划线点斜杠，不含空段与 . / .. */
function isSafePackagePath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > LIMITS.pathLength) return false;
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(p)) return false;
  return p.split("/").every((seg) => seg && seg !== "." && seg !== "..");
}

function isUuidV7(id) {
  return typeof id === "string" && id.length === 36 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
}

// ---------------------------------------------------------------- 校验

function validateManifest(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    err("Invalid mini-app manifest: 顶层必须是对象");
    return;
  }

  if (m.format !== 1) err("Invalid mini-app manifest: format 必须是 1");

  if (!isUuidV7(m.id)) {
    err("Invalid mini-app manifest: id 必须是应用页面分配的 UUIDv7（36 字符），"
      + "当前值 " + JSON.stringify(m.id));
  } else if (m.id === "00000000-0000-7000-8000-000000000000") {
    // 格式上是合法 UUIDv7，但这是脚手架占位符，不是任何应用页分配的 ID。
    // 校验器无法知道应用页的真实 ID，所以只能警告，不能直接报错：
    // 用这个 ID 上传必定 APP_ID_MISMATCH，但本地沙箱脚手架测试仍可用它占位。
    warn("占位 ID：当前 id 是脚手架模板的占位符，不是社区应用页分配的 ID，"
      + "上传前必须换成应用页的 UUIDv7，否则平台报 APP_ID_MISMATCH");
  }

  if (typeof m.version !== "string" ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(m.version) ||
      m.version.length > 64 || m.version.trim() !== m.version) {
    err("Invalid mini-app manifest: version 必须是三段数字且无前导零（如 1.0.0），"
      + "当前值 " + JSON.stringify(m.version));
  }

  if (m.entry !== "index.html") err("Invalid mini-app manifest: entry 必须是 index.html");
  if (m.script !== "app.js") err("Invalid mini-app manifest: script 必须是 app.js");
  if (m.style !== "app.css") err("Invalid mini-app manifest: style 必须是 app.css");

  if (!Array.isArray(m.permissions)) {
    err("Invalid mini-app manifest: permissions 必须是数组");
  } else {
    const bad = m.permissions.filter((p) => !PERMISSIONS.has(p));
    if (bad.length) {
      err("Invalid mini-app manifest: 未知权限 " + JSON.stringify(bad)
        + "，合法取值见 references/manifest.md");
    }
    if (new Set(m.permissions).size !== m.permissions.length) {
      err("Invalid mini-app manifest: permissions 不能有重复项");
    }
  }

  const permSet = new Set(m.permissions || []);
  const remoteKeys = new Set(Object.keys(m.remote_assets || {}));

  validateMedia(m, permSet, remoteKeys);
  validateEndpoints(m, permSet);
  validateWebsockets(m, permSet);

  // 官方 packer 的顺序：端点校验之后才统一检查 user.read。
  // 任一端点用 platform 鉴权，就必须申请 user.read 权限。
  const usesPlatform = [
    ...Object.values(m.endpoints || {}),
    ...Object.values(m.websockets || {}),
  ].some((d) => d && d.auth === "platform");
  if (usesPlatform && !permSet.has("user.read")) {
    err("Platform authentication requires user.read: 有端点使用 platform 鉴权，"
      + "但 manifest 未申请 user.read 权限");
  }

  validateRemoteAssets(m, permSet, remoteKeys);
  validateAssets(m, remoteKeys);
}

function validateMedia(m, permSet, remoteKeys) {
  if (m.media === undefined) return;
  if (!m.media || typeof m.media !== "object" || Array.isArray(m.media)) {
    err("Invalid media manifest: media 必须是对象");
    return;
  }
  const entries = Object.entries(m.media);
  for (const [id, decl] of entries) {
    if (id.length < 1 || id.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      err("Invalid media asset declaration: 媒体 ID " + JSON.stringify(id)
        + " 只能含字母、数字、下划线、连字符，长度 1–64");
      continue;
    }
    if (PROTO_KEYS.has(id)) {
      err("Invalid media asset declaration: 媒体 ID 不能是 " + id);
      continue;
    }
    if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
      err("Invalid media asset declaration: " + id + " 必须是对象");
      continue;
    }
    const { path, kind, mime } = decl;
    if (!MEDIA_MIMES.has(mime)) {
      err("Invalid media asset declaration: " + id + " 的 mime 不支持：" + mime);
    }
    // 官方要求 kind 与 mime 严格对应，不能自由组合
    const expectedKind = mime && mime.startsWith("audio/") ? "audio"
      : mime && mime.startsWith("video/") ? "video" : null;
    if (expectedKind && kind !== expectedKind) {
      err("Invalid media asset declaration: " + id + " 的 kind(" + kind
        + ") 与 mime(" + mime + ") 不匹配，应为 " + expectedKind);
    }
    if (kind !== "audio" && kind !== "video") {
      err("Invalid media asset declaration: " + id + " 的 kind 必须是 audio 或 video");
    }
    if (typeof path !== "string" || !/^media\/[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(path)) {
      err("Invalid media asset declaration: " + id
        + " 的 path 必须匹配 media/[A-Za-z0-9_-]+\\.[a-z0-9]+");
    }
    // 远程媒体的 MIME 必须与清单完全一致
    if (typeof path === "string" && remoteKeys.has(path)) {
      const remote = m.remote_assets[path];
      if (remote && remote.mime !== mime) {
        err("Remote media type mismatch: " + path + " 的 media mime(" + mime
          + ") 与 remote_assets mime(" + remote.mime + ") 不一致");
      }
    }
    if (kind === "video" && !permSet.has("video.play")) {
      warn("媒体 " + id + " 是视频，但 manifest 未申请 video.play 权限");
    }
    if (kind === "audio" && !permSet.has("audio.play")) {
      warn("媒体 " + id + " 是音频，但 manifest 未申请 audio.play 权限");
    }
  }
}

function validateEndpointUrl(url, isWs, label) {
  if (typeof url !== "string") {
    err("Invalid endpoint declaration: " + label + " 的 url 必须是字符串");
    return false;
  }
  if (new TextEncoder().encode(url).length > LIMITS.urlBytes) {
    err("Invalid endpoint URL: " + label + " 的 url 超过 " + LIMITS.urlBytes + " 字节");
    return false;
  }
  const m = url.match(/^[a-z]+:\/\/((?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]*)?)(\/[^?#]*)?(?:\?[^#]*)?$/i);
  if (!m || /[^\x21-\x7e]|\\/.test(url) ||
      (m[2] || "").split("/").some((seg) => [".", ".."].includes(seg.replace(/%2e/gi, ".")))) {
    err("Invalid endpoint URL: " + label + " 的 url 格式非法");
    return false;
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    err("Invalid endpoint URL: " + label + " 的 url 无法解析");
    return false;
  }
  const wantProto = isWs ? "wss:" : "https:";
  if (u.protocol !== wantProto) {
    err("Invalid endpoint URL: " + label + " 必须使用 " + wantProto + "，当前 " + u.protocol);
    return false;
  }
  if (u.username || u.password) {
    err("Invalid endpoint URL: " + label + " 不能包含账号密码");
    return false;
  }
  if (u.hash) err("Invalid endpoint URL: " + label + " 不能包含片段");
  if (u.port) err("Invalid endpoint URL: " + label + " 必须使用默认 443 端口");
  if (u.searchParams.has("mini_app_token")) {
    err("Invalid endpoint URL: " + label + " 不能使用保留参数 mini_app_token");
  }
  return true;
}

function validateQuery(query, url, label) {
  if (query === undefined) return;
  if (!Array.isArray(query)) {
    err("Invalid endpoint declaration: " + label + " 的 query 必须是数组");
    return;
  }
  if (query.length > LIMITS.queryCount) {
    err("Invalid endpoint declaration: " + label + " 的 query 超过 " + LIMITS.queryCount + " 项");
  }
  if (new Set(query).size !== query.length) {
    err("Invalid endpoint declaration: " + label + " 的 query 不能有重复项");
  }
  const existing = new Set();
  try {
    for (const k of new URL(url).searchParams.keys()) existing.add(k);
  } catch {
    /* URL 非法时已在别处报错 */
  }
  for (const q of query) {
    if (typeof q !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(q)) {
      err("Invalid endpoint declaration: " + label
        + " 的 query 项名非法（只允许字母、数字、下划线、点、连字符，1–64 字符）");
      continue;
    }
    if (q === "mini_app_token") {
      err("Invalid endpoint declaration: " + label + " 的 query 不能使用保留参数 mini_app_token");
    }
    if (existing.has(q)) {
      err("Invalid endpoint declaration: " + label + " 的 query 项 " + q
        + " 与 URL 里已存在的参数冲突");
    }
  }
}

function validateHeaders(headers, label, isWs) {
  if (isWs && headers !== undefined) {
    err("WebSocket endpoints cannot declare headers: " + label);
    return;
  }
  if (headers === undefined) return;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    err("Invalid endpoint headers: " + label);
    return;
  }
  const entries = Object.entries(headers);
  if (entries.length > LIMITS.headerCount) {
    err("Invalid endpoint headers: " + label + " 超过 " + LIMITS.headerCount + " 项");
  }
  for (const [name, value] of entries) {
    if (name.length > LIMITS.headerNameLength) {
      err("Invalid endpoint headers: " + label + " 的头名 " + name + " 超过 "
        + LIMITS.headerNameLength + " 字符");
    }
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
      err("Invalid endpoint headers: " + label + " 不允许声明敏感头 " + name);
    }
    if (typeof value !== "string" || new TextEncoder().encode(value).length > LIMITS.headerValueBytes) {
      err("Invalid endpoint headers: " + label + " 的头 " + name + " 的值超过 "
        + LIMITS.headerValueBytes + " 字节或不是字符串");
    }
  }
}

function validateEndpoints(m, permSet) {
  if (m.endpoints === undefined) return;
  if (!m.endpoints || typeof m.endpoints !== "object" || Array.isArray(m.endpoints)) {
    err("Invalid endpoint declarations: endpoints 必须是对象");
    return;
  }
  const entries = Object.entries(m.endpoints);
  if (entries.length > LIMITS.endpointCount) {
    err("Invalid endpoint declarations: HTTP 端点超过 " + LIMITS.endpointCount + " 个");
  }
  for (const [name, decl] of entries) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) {
      err("Invalid endpoint declaration: 端点名 " + JSON.stringify(name) + " 非法");
      continue;
    }
    if (PROTO_KEYS.has(name)) {
      err("Invalid endpoint declaration: 端点名不能是 " + name);
      continue;
    }
    if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
      err("Invalid endpoint declaration: " + name + " 必须是对象");
      continue;
    }
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(decl.method)) {
      err("Invalid endpoint declaration: " + name + " 必须声明 method"
        + "（GET/POST/PUT/PATCH/DELETE）");
    }
    validateEndpointUrl(decl.url, false, name);
    validateQuery(decl.query, decl.url, name);
    validateHeaders(decl.headers, name, false);
    if (decl.auth !== undefined && decl.auth !== "none" && decl.auth !== "platform") {
      err("Invalid endpoint authentication: " + name + " 的 auth 只能是 none 或 platform");
    }
  }
}

function validateWebsockets(m, permSet) {
  if (m.websockets === undefined) return;
  if (!m.websockets || typeof m.websockets !== "object" || Array.isArray(m.websockets)) {
    err("Invalid endpoint declarations: websockets 必须是对象");
    return;
  }
  const entries = Object.entries(m.websockets);
  if (entries.length > LIMITS.endpointCount) {
    err("Invalid endpoint declarations: WS 端点超过 " + LIMITS.endpointCount + " 个");
  }
  for (const [name, decl] of entries) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) {
      err("Invalid endpoint declaration: 端点名 " + JSON.stringify(name) + " 非法");
      continue;
    }
    if (PROTO_KEYS.has(name)) {
      err("Invalid endpoint declaration: 端点名不能是 " + name);
      continue;
    }
    if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
      err("Invalid endpoint declaration: " + name + " 必须是对象");
      continue;
    }
    validateEndpointUrl(decl.url, true, name);
    validateQuery(decl.query, decl.url, name);
    validateHeaders(decl.headers, name, true);
    if (decl.auth !== "platform") {
      err("WebSocket endpoints require platform authentication: " + name);
    }
    if (decl.protocols !== undefined) {
      if (!Array.isArray(decl.protocols) || decl.protocols.length > LIMITS.protocolCount) {
        err("Invalid websocket protocols: " + name + " 的 protocols 必须是数组且不超过 "
          + LIMITS.protocolCount + " 项");
      } else if (decl.protocols.some((p) => typeof p !== "string" || !p)) {
        err("Invalid websocket protocols: " + name + " 的 protocols 项必须是非空字符串");
      }
    }
  }
}

function validateRemoteAssets(m, permSet, remoteKeys) {
  if (m.remote_assets === undefined) return;
  const ra = m.remote_assets;
  if (!ra || typeof ra !== "object" || Array.isArray(ra)) {
    err("Invalid remote asset declarations: remote_assets 必须是对象");
    return;
  }
  const entries = Object.entries(ra);
  if (entries.length > LIMITS.remoteAssetCount) {
    err("Invalid remote asset declarations: 清单超过 " + LIMITS.remoteAssetCount + " 项");
  }
  let total = 0;
  const declaredPaths = new Set();

  for (const [key, decl] of entries) {
    if (!isSafePackagePath(key)) {
      err("Invalid remote asset declaration: 虚拟路径 " + JSON.stringify(key) + " 非法");
      continue;
    }
    if (/\.(?:js|mjs|cjs|ts|css|html|htm|map)$/i.test(key)) {
      err("Invalid remote asset declaration: " + key
        + " 不能是脚本或样式文件（远程素材不提供代码加载执行能力）");
    }
    if (declaredPaths.has(key)) {
      err("Invalid remote asset declaration: 重复的虚拟路径 " + key);
    }
    declaredPaths.add(key);
    if (BASE_FILES.includes(key.toLowerCase())) {
      err("Remote asset duplicates a local file: " + key + " 与基础文件重名");
    }

    if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
      err("Invalid remote asset declaration: " + key + " 必须是对象");
      continue;
    }
    const keys = Object.keys(decl).sort().join(",");
    if (keys !== "mime,sha256,size,url") {
      err("Invalid remote asset declaration: " + key
        + " 只能包含 url、sha256、size、mime 四个字段，实际字段：" + keys);
      continue;
    }
    if (typeof decl.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(decl.sha256)) {
      err("Invalid remote asset declaration: " + key + " 的 sha256 必须是 64 位小写十六进制");
    }
    if (typeof decl.size !== "number" || !Number.isSafeInteger(decl.size) || decl.size < 1) {
      err("Invalid remote asset declaration: " + key + " 的 size 必须是 ≥ 1 的整数");
    } else {
      if (decl.size > LIMITS.remoteAssetBytes) {
        err("Remote asset size limit exceeded: " + key + " 超过 " + LIMITS.remoteAssetBytes + " 字节");
      }
      total += decl.size;
    }
    if (!REMOTE_MIMES.has(decl.mime)) {
      err("Invalid remote asset declaration: " + key + " 的 mime 不支持：" + decl.mime);
    }
    if (typeof decl.url !== "string") {
      err("Invalid remote asset URL: " + key + " 的 url 必须是字符串");
      continue;
    }
    const u = decl.url;
    if (u.length > 2048) {
      err("Invalid remote asset URL: " + key + " 的 url 超过 2048 字符");
      continue;
    }
    if (/%(?![0-9a-f]{2})/i.test(u)) {
      err("Invalid remote asset URL: " + key + " 含有未编码的百分号");
      continue;
    }
    if (!/^https:\/\//.test(u) || /[^\x21-\x7e]|\\/.test(u)) {
      err("Invalid remote asset URL: " + key + " 必须是无特殊字符的 HTTPS 地址");
      continue;
    }
    if (u.includes("@")) {
      err("Invalid remote asset URL: " + key + " 不能包含账号密码");
    }
    if (/#/.test(u)) {
      err("Invalid remote asset URL: " + key + " 不能包含片段");
    }
    if (/[?&]mini_app_token=/.test(u)) {
      err("Invalid remote asset URL: " + key + " 不能使用 mini_app_token");
    }
    const host = (() => {
      try { return new URL(u).hostname; } catch { return ""; }
    })();
    if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") ||
        host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
      err("Invalid remote asset URL: " + key + " 必须使用公开 CDN 域名，不能用 IP 或内网地址");
    }
    try {
      const parsed = new URL(u);
      if (parsed.port) {
        err("Invalid remote asset URL: " + key + " 必须使用默认 443 端口");
      }
    } catch {
      err("Invalid remote asset URL: " + key + " 无法解析");
    }
  }

  if (total > LIMITS.remoteAssetTotalBytes) {
    err("Remote asset size limit exceeded: 清单总大小超过 " + LIMITS.remoteAssetTotalBytes + " 字节");
  }
  if (entries.length > 0 && !permSet.has("assets.remote")) {
    err("Remote assets require assets.remote: 声明了 remote_assets 但未申请该权限");
  }
}

function validateAssets(m, remoteKeys) {
  if (m.assets === undefined) return;
  if (!Array.isArray(m.assets)) {
    err("Invalid assets list: assets 必须是数组");
    return;
  }
  if (m.assets.length > LIMITS.fileCount) {
    err("Invalid assets list: assets 超过 " + LIMITS.fileCount + " 项");
  }
  if (new Set(m.assets).size !== m.assets.length) {
    err("Invalid assets list: 不能有重复路径");
  }
  const seen = new Set();
  for (const p of m.assets) {
    if (typeof p !== "string") {
      err("Invalid assets list: 路径必须是字符串");
      continue;
    }
    if (!isSafePackagePath(p)) {
      err("Invalid assets list: 路径 " + JSON.stringify(p)
        + " 非法（只允许 [a-zA-Z0-9_.-/]，长度 ≤ " + LIMITS.pathLength
        + "，无空段与 . / ..）");
      continue;
    }
    if (seen.has(p)) {
      err("Invalid assets list: 重复路径 " + p);
    }
    seen.add(p);
    if (BASE_FILES.includes(p.toLowerCase())) {
      err("Invalid assets list: " + p + " 是基础文件，无需重复列入");
    }
    if (remoteKeys.has(p)) {
      err("Remote asset duplicates a local file: " + p + " 同时出现在 assets 与 remote_assets");
    }
  }
}

// ---------------------------------------------------------------- 项目检查

function validateProject(projectDir, manifest) {
  const files = [];

  // 基础文件可能直接在项目根（纯手写项目），也在 dist/web（Vite 构建产物）。
  // 只有当候选目录里确实有 app.js 时才认定它是产物目录，
  // 否则回退到项目根 —— 否则会把 README、package.json 这些
  // 不进包的文件误报成「多余文件」。
  const candidates = ["dist/web", "web", "public", "build"];
  let webDir = projectDir;
  for (const d of candidates) {
    const p = join(projectDir, d);
    if (existsSync(join(p, "app.js"))) {
      webDir = p;
      break;
    }
  }
  const isBuildDir = webDir !== projectDir;

  for (const base of BASE_FILES) {
    if (base === "manifest.json") continue;
    const p = join(webDir, base);
    if (!existsSync(p)) {
      err("Files do not match the manifest: 缺少基础文件 " + base
        + "（应在 " + webDir + "）");
    } else if (statSync(p).isDirectory()) {
      err("Only regular files can be packaged: " + base + " 是目录");
    }
  }

  // assets 与 media 声明的文件必须存在
  const declared = [...(manifest.assets || [])];
  const mediaPaths = [];
  for (const decl of Object.values(manifest.media || {})) {
    if (decl && typeof decl.path === "string") {
      mediaPaths.push(decl.path);
      if (!remoteKeysOf(manifest).has(decl.path)) {
        declared.push(decl.path);
      }
    }
  }
  for (const p of declared) {
    const abs = join(webDir, p);
    if (!existsSync(abs)) {
      err("Files do not match the manifest: 声明了 " + p + " 但文件不存在");
    } else if (statSync(abs).isDirectory()) {
      err("Only regular files can be packaged: " + p + " 是目录");
    }
  }

  // 官方要求包内文件集合与 manifest 声明**完全一致**：
  // 四个基础文件 + 包内 media + assets。多一个或少一个都拒。
  const expected = new Set([
    ...BASE_FILES.filter((f) => f !== "manifest.json"),
    ...mediaPaths.filter((p) => !remoteKeysOf(manifest).has(p)),
    ...(manifest.assets || []),
  ]);

  // 只在能确定产物目录时扫描多余文件 —— 纯手写项目里源码和产物混在一起，
  // 扫整个项目根会把源码、README、package.json 全报成多余文件。
  if (isBuildDir) {
    const extra = scanExtra(webDir, expected);
    for (const rel of extra) {
      err("Files do not match the manifest: " + rel
        + " 在包里但未在 manifest 的 assets/media 中声明");
    }
  }

  // index.html 是片段
  const indexPath = join(webDir, "index.html");
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8");
    if (/<script\b/i.test(html)) {
      err("Invalid index.html: 不能包含 <script> 标签（脚本由 manifest 的 script 字段注入）");
    }
    if (/<style\b/i.test(html)) {
      err("Invalid index.html: 不能包含内联 <style>（样式放在 app.css）");
    }
    if (/\son[a-z]+\s*=/i.test(html)) {
      err("Invalid index.html: 不能包含 on* 事件属性（用 addEventListener）");
    }
  }

  // strings.json 合法
  const stringsPath = join(webDir, "strings.json");
  if (existsSync(stringsPath)) {
    try {
      const raw = readFileSync(stringsPath, "utf8");
      JSON.parse(raw);
      if (Buffer.byteLength(raw, "utf8") > 512 * 1024) {
        warn("strings.json 超过 512 KiB，考虑把长文案移到 assets");
      }
    } catch (e) {
      err("Invalid strings.json: " + e.message);
    }
  }

  // 包体总量与文件数
  let total = 0;
  let count = 0;
  const all = new Set([...BASE_FILES, ...declared]);
  for (const rel of all) {
    const abs = join(webDir, rel);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    const size = statSync(abs).size;
    total += size;
    count++;
    if (size > LIMITS.fileBytes) {
      err("Package file limit exceeded: " + rel + " 超过单文件 " + LIMITS.fileBytes + " 字节");
    }
  }
  if (count > LIMITS.fileCount) {
    err("Invalid file count: 文件数 " + count + " 超过 " + LIMITS.fileCount);
  }
  if (total > LIMITS.expandedBytes) {
    err("Package file limit exceeded: 解压总量 " + total + " 超过 " + LIMITS.expandedBytes + " 字节");
  }

  // 首屏内容大小：manifest + index.html + app.js + app.css 不宜过大
  const startup = ["manifest.json", "index.html", "app.js", "app.css"]
    .reduce((sum, rel) => {
      const abs = rel === "manifest.json" ? join(projectDir, rel) : join(webDir, rel);
      return sum + (existsSync(abs) && !statSync(abs).isDirectory() ? statSync(abs).size : 0);
    }, 0);
  if (startup > 2 * 1024 * 1024) {
    warn("Startup content is too large（" + Math.round(startup / 1024) + " KiB）:"
      + " 大数据文件请放到 assets，用 sdk.assets.readJson() 读取");
  }

  return { fileCount: count, totalBytes: total, webDir };
}

function remoteKeysOf(manifest) {
  return new Set(Object.keys(manifest.remote_assets || {}));
}

/**
 * 扫出 web 目录里未被 manifest 声明的文件。
 * 只报告「会被打进包的多余文件」，忽略构建工具的中间产物目录。
 */
function scanExtra(webDir, expected) {
  const extras = [];
  const IGNORED_DIRS = new Set([".git", "node_modules", ".vite", "dist"]);

  function walk(dir, prefix) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!expected.has(rel)) extras.push(rel);
    }
  }

  walk(webDir, "");
  return extras;
}

// ---------------------------------------------------------------- 主流程

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");

  let manifestPath = null;
  let projectDir = null;

  if (rest[0] === "--manifest") {
    manifestPath = rest[1];
    projectDir = resolve(manifestPath, "..");
  } else if (rest[0]) {
    projectDir = resolve(rest[0]);
    manifestPath = join(projectDir, "manifest.json");
  } else {
    process.stderr.write("用法: node validate.mjs <项目目录> | --manifest <manifest.json>\n");
    process.exit(2);
  }

  if (!existsSync(manifestPath)) {
    process.stderr.write("找不到 manifest: " + manifestPath + "\n");
    process.exit(2);
  }

  const raw = readFileSync(manifestPath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > LIMITS.manifestBytes) {
    err("Manifest exceeds 64 KiB: 实际 " + Buffer.byteLength(raw, "utf8") + " 字节");
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    err("Invalid mini-app manifest: JSON 解析失败 —— " + e.message);
    manifest = {};
  }

  validateManifest(manifest);
  let stats = null;
  if (errors.length === 0) {
    stats = validateProject(projectDir, manifest);
  }

  const result = {
    ok: errors.length === 0,
    manifest: manifestPath,
    errors,
    warnings,
    stats,
  };

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const label = manifest.name ? "（" + manifest.name + "）" : "";
    if (result.ok) {
      process.stdout.write("OK  manifest 校验通过" + label + "\n");
      if (stats) {
        process.stdout.write("    文件 " + stats.fileCount + " 个，展开 "
          + (stats.totalBytes / 1024).toFixed(1) + " KiB\n");
      }
    } else {
      process.stdout.write("FAIL  manifest 校验未通过" + label + "，共 " + errors.length + " 个问题\n");
      for (const e of errors) process.stdout.write("  ✗ " + e + "\n");
    }
    for (const w of warnings) process.stdout.write("  ! " + w + "\n");
  }

  process.exit(result.ok ? 0 : 1);
}

main();
