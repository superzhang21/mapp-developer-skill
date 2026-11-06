#!/usr/bin/env node
/**
 * 无 Bun 环境下打包 app.zip。
 *
 *   node pack.mjs <manifest.json> <web目录> <输出目录> [--allow-placeholder]
 *   MINI_APP_ID=<UUIDv7> node pack.mjs <manifest.json> <web目录> <输出目录>
 *
 * 占位 ID 默认拒绝；仅本地测试用 --allow-placeholder 或
 * MINI_APP_ALLOW_PLACEHOLDER_ID=1 放行。产物须再用 check_zip.mjs 验证。
 */

import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const BASE_FILES = ["index.html", "app.js", "app.css", "strings.json"];

function fail(msg) {
  process.stderr.write("打包失败: " + msg + "\n");
  process.exit(1);
}

const PLACEHOLDER_ID = "00000000-0000-7000-8000-000000000000";
const rawArgs = process.argv.slice(2);
const allowPlaceholder = rawArgs.includes("--allow-placeholder")
  || process.env.MINI_APP_ALLOW_PLACEHOLDER_ID === "1";
const args = rawArgs.filter((a) => a !== "--allow-placeholder");
const [manifestArg, webArg, outArg] = args;
if (!manifestArg || !webArg || !outArg || args.length !== 3) {
  process.stderr.write("用法: node pack.mjs <manifest.json> <web目录> <输出目录> [--allow-placeholder]\n");
  process.exit(2);
}

const manifestPath = resolve(manifestArg);
const webDir = resolve(webArg);
const outDir = resolve(outArg);

if (!existsSync(manifestPath)) fail("找不到 manifest: " + manifestPath);
if (!existsSync(webDir)) fail("找不到 web 目录: " + webDir);

const manifestBytesRaw = readFileSync(manifestPath, "utf8");
if (Buffer.byteLength(manifestBytesRaw, "utf8") > 64 * 1024) fail("manifest.json 超过 64 KiB");
const manifest = JSON.parse(manifestBytesRaw);
// 应用 ID 门禁：MINI_APP_ID 优先覆盖 manifest 里的 id（与模板 Bun 路径一致），
// 覆盖后仍是占位符、或 manifest 本来就是占位符时，默认拒绝打包。
if (process.env.MINI_APP_ID) {
  manifest.id = process.env.MINI_APP_ID;
}
if (manifest.id === PLACEHOLDER_ID && !allowPlaceholder) {
  fail("拒绝打包：manifest id 仍是脚手架占位符 " + PLACEHOLDER_ID
    + "，不是社区应用页分配的 ID。先去社区个人资料的应用页创建应用，"
    + "原样复制它分配的 UUIDv7，再写进 manifest.json 的 id，"
    + "或用 MINI_APP_ID=<应用ID> 重新打包。仅本地脚手架测试可用 "
    + "--allow-placeholder 或 MINI_APP_ALLOW_PLACEHOLDER_ID=1 放行，"
    + "放行产物不能上传。");
}
if (process.env.MINI_APP_ID
  && !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(manifest.id)) {
  fail("MINI_APP_ID 不是合法 UUIDv7：请从社区应用页原样复制，不要自己编");
}
const manifestBytes = process.env.MINI_APP_ID
  ? JSON.stringify(manifest, null, 2) + "\n"
  : manifestBytesRaw;
const files = new Map();

// manifest 本身必须在 ZIP 根目录：上游 SDK 的 pack 会自动把它写进去，
// 本替代表没有 SDK 代劳，必须显式写进去，否则包里就没有平台契约。
files.set("manifest.json", Buffer.from(manifestBytes, "utf8"));

// 四个基础文件
for (const name of BASE_FILES) {
  const p = join(webDir, name);
  if (!existsSync(p)) fail("缺少基础文件: " + name + "（应位于 " + webDir + "）");
  files.set(name, readFileSync(p));
}

// assets 声明的资源
for (const rel of manifest.assets || []) {
  const p = join(webDir, rel);
  if (!existsSync(p)) fail("assets 声明了 " + rel + " 但 " + p + " 不存在");
  files.set(rel, readFileSync(p));
}

// media 声明的音视频
const remoteKeys = new Set(Object.keys(manifest.remote_assets || {}));
for (const decl of Object.values(manifest.media || {})) {
  if (!decl || typeof decl.path !== "string") continue;
  if (remoteKeys.has(decl.path)) continue;   // 远程媒体不进 ZIP
  const p = join(webDir, decl.path);
  if (!existsSync(p)) fail("media 声明了 " + decl.path + " 但 " + p + " 不存在");
  files.set(decl.path, readFileSync(p));
}

if (files.size > 128) fail("文件数 " + files.size + " 超过 128");
let total = 0;
for (const [name, buf] of files) {
  total += buf.length;
  if (buf.length > 8 * 1024 * 1024) fail(name + " 超过单文件 8 MiB");
}
if (total > 32 * 1024 * 1024) fail("展开总量超过 32 MiB");

mkdirSync(outDir, { recursive: true });

// 用 Node 内置 zlib 构造 ZIP（deflate + store 混合，无需第三方依赖）
import { deflateRawSync } from "node:zlib";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const localParts = [];
const centralParts = [];
let offset = 0;

for (const [name, content] of files) {
  const nameBuf = Buffer.from(name, "utf8");
  const deflated = deflateRawSync(content);
  const useDeflate = deflated.length < content.length;
  const data = useDeflate ? deflated : content;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(content);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);        // version needed
  local.writeUInt16LE(0, 6);         // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);        // time
  local.writeUInt16LE(0x21, 12);     // date (1996-01-01，固定值保证可复现)
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, nameBuf, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);      // version made by
  central.writeUInt16LE(20, 6);      // version needed
  central.writeUInt16LE(0, 8);       // flags
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);      // extra
  central.writeUInt16LE(0, 32);      // comment
  central.writeUInt16LE(0, 34);      // disk
  central.writeUInt16LE(0, 36);      // internal attrs
  central.writeUInt32LE(0o644 << 16, 38); // external attrs
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, nameBuf);

  offset += local.length + nameBuf.length + data.length;
}

const centralBuf = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.size, 8);
end.writeUInt16LE(files.size, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const zip = Buffer.concat([...localParts, centralBuf, end]);
const zipPath = join(outDir, "app.zip");
writeFileSync(zipPath, zip);

const sha256 = createHash("sha256").update(zip).digest("hex");
const meta = {
  name: manifest.name || null,
  id: manifest.id,
  version: manifest.version,
  permissions: manifest.permissions,
  zipSha256: sha256,
  size: zip.length,
  builtAt: new Date().toISOString(),
};
writeFileSync(join(outDir, "package.json"), JSON.stringify(meta, null, 2) + "\n");

process.stdout.write("Created " + zipPath + " (" + zip.length + " bytes)\n");
process.stdout.write("  app " + manifest.id + ", version " + manifest.version + "\n");
process.stdout.write("  sha256 " + sha256 + "\n");
