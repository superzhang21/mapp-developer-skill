#!/usr/bin/env node
/**
 * 校验已打好的 app.zip（目录校验通过不代表包通过）。
 *
 *   node check_zip.mjs <app.zip> [--allow-placeholder]
 *
 * 检查 ZIP 结构、manifest 合法性、包内文件集合、限额，并解压重跑
 * validate.mjs。占位 ID 默认拒绝。只用 Node 内置模块。
 * 退出码：0 通过 / 1 失败 / 2 用法错误。
 */

import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const validatePath = join(here, "validate.mjs");

function fail(msg) {
  process.stderr.write("check_zip 失败: " + msg + "\n");
  process.exit(1);
}

const PLACEHOLDER_ID = "00000000-0000-7000-8000-000000000000";
const rawArgs = process.argv.slice(2);
const allowPlaceholder = rawArgs.includes("--allow-placeholder");
const zipArgs = rawArgs.filter((a) => a !== "--allow-placeholder");
const zipPath = zipArgs[0];
if (!zipPath || zipArgs.length !== 1) {
  process.stderr.write("用法: node check_zip.mjs <app.zip> [--allow-placeholder]\n");
  process.exit(2);
}

let buf;
try {
  buf = readFileSync(zipPath);
} catch (e) {
  fail("读不到 " + zipPath + "：" + e.message);
}

// ---- 解析 ZIP 中央目录 ----
let eocd = -1;
const tailStart = Math.max(0, buf.length - 65557);
for (let i = buf.length - 22; i >= tailStart; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) fail("找不到 ZIP 结束目录，不是合法 ZIP");
const totalEntries = buf.readUInt16LE(eocd + 10);
const cdOffset = buf.readUInt32LE(eocd + 16);

const files = new Map();
let p = cdOffset;
for (let i = 0; i < totalEntries; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) fail("中央目录损坏，条目 " + i);
  const method = buf.readUInt16LE(p + 10);
  const compSize = buf.readUInt32LE(p + 20);
  const uncompSize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const localOffset = buf.readUInt32LE(p + 42);
  const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
  if (files.has(name)) fail("ZIP 内重复文件：" + name);
  if (name.endsWith("/")) fail("ZIP 内含目录项：" + name);
  if (name.startsWith("/") || name.split("/").some((s) => s === "" || s === "." || s === "..")) {
    fail("ZIP 内含非法路径：" + name);
  }
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) fail("本地文件头损坏：" + name);
  const localNameLen = buf.readUInt16LE(localOffset + 26);
  const localExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLen + localExtraLen;
  const comp = buf.subarray(dataStart, dataStart + compSize);
  let content;
  if (method === 0) content = Buffer.from(comp);
  else if (method === 8) {
    try { content = inflateRawSync(comp); } catch (e) { fail("解压失败 " + name + "：" + e.message); }
  } else fail("不支持的压缩方法 " + method + "：" + name);
  if (content.length !== uncompSize) fail("解压后大小与中央目录不符：" + name);
  files.set(name, content);
  p += 46 + nameLen + extraLen + commentLen;
}

if (!files.has("manifest.json")) fail("ZIP 内缺少 manifest.json（这是旧版 pack.mjs 的已知 bug，见 pack.mjs 注释）");

let manifest;
try {
  manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
} catch (e) {
  fail("包内 manifest.json 不是合法 JSON：" + e.message);
}
if (manifest.id === PLACEHOLDER_ID && !allowPlaceholder) {
  fail("包内 manifest id 仍是脚手架占位符 " + PLACEHOLDER_ID
    + "，不是社区应用页分配的 ID，上传必定 APP_ID_MISMATCH。"
    + "先去社区个人资料的应用页创建应用，原样复制它分配的 UUIDv7，"
    + "重打一包再验。仅本地脚手架测试可用 --allow-placeholder 显式放行。");
}

const remoteKeys = new Set(Object.keys(manifest.remote_assets || {}));
const expected = new Set(["manifest.json", "index.html", "app.js", "app.css", "strings.json"]);
for (const rel of manifest.assets || []) expected.add(rel);
for (const decl of Object.values(manifest.media || {})) {
  if (decl && typeof decl.path === "string" && !remoteKeys.has(decl.path)) expected.add(decl.path);
}

const missing = [...expected].filter((f) => !files.has(f));
const extra = [...files.keys()].filter((f) => !expected.has(f));
if (missing.length) fail("ZIP 缺少文件：" + missing.join(", "));
if (extra.length) fail("ZIP 多余文件（未在 manifest 声明）：" + extra.join(", "));

if (files.size > 128) fail("文件数 " + files.size + " 超过 128");
let total = 0;
for (const [name, content] of files) {
  total += content.length;
  if (content.length > 8 * 1024 * 1024) fail(name + " 超过单文件 8 MiB");
}
if (total > 32 * 1024 * 1024) fail("展开总量超过 32 MiB");
if (files.get("manifest.json").length > 64 * 1024) fail("manifest.json 超过 64 KiB");

// ---- 解压后复用 validate.mjs ----
const tmp = mkdtempSync(join(tmpdir(), "mapp-check-zip-"));
try {
  for (const [name, content] of files) {
    const dest = join(tmp, name);
    // 上面已排除了越界路径，用 join 后的相对路径写盘是安全的
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  let out = "";
  try {
    out = execFileSync("node", [validatePath, tmp], { encoding: "utf8" });
  } catch (e) {
    process.stderr.write((e.stdout || "") + (e.stderr || ""));
    fail("解压后 validate.mjs 未通过，见上文");
  }
  const sha = createHash("sha256").update(buf).digest("hex");
  process.stdout.write("OK  ZIP 校验通过（" + manifest.name + " " + manifest.version + "）\n");
  process.stdout.write("    文件 " + files.size + " 个，展开 " + (total / 1024).toFixed(1) + " KiB，sha256 " + sha + "\n");
  if (out.trim()) process.stdout.write(out);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
