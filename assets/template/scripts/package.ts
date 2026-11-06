import type { MiniAppManifest } from "@discourse-mini-app/sdk/pack";
import { pack } from "@discourse-mini-app/sdk/pack";
import { copyFile, readFile } from "node:fs/promises";

/**
 * 打包成 app.zip。
 *
 * 应用 ID 与版本号从环境变量注入，这样同一份源码能产出任意应用的包：
 *   MINI_APP_ID=<app-id> MINI_APP_VERSION=1.0.0 bun run build
 */

const manifest = JSON.parse(
  await readFile("manifest.json", "utf8"),
) as MiniAppManifest;

manifest.id = process.env.MINI_APP_ID || manifest.id;
manifest.version = process.env.MINI_APP_VERSION || manifest.version;

// 应用 ID 门禁（打包前置，见 SKILL.md“先拿应用 ID”）：
// 打包前必须先去社区应用页创建应用、复制它分配的 UUIDv7。
// 最终 id 仍是脚手架占位符时默认拒绝打包，用占位包上传必定 APP_ID_MISMATCH。
// 仅本地脚手架测试可用 MINI_APP_ALLOW_PLACEHOLDER_ID=1 显式放行，放行产物不能上传。
const PLACEHOLDER_ID = "00000000-0000-7000-8000-000000000000";
if (
  manifest.id === PLACEHOLDER_ID &&
  process.env.MINI_APP_ALLOW_PLACEHOLDER_ID !== "1"
) {
  throw new Error(
    "拒绝打包：manifest id 仍是脚手架占位符 " + PLACEHOLDER_ID +
      "，不是社区应用页分配的 ID。先去社区个人资料的应用页创建应用，" +
      "原样复制它分配的 UUIDv7，再用 MINI_APP_ID=<应用ID> 重新打包。" +
      "仅本地脚手架测试可用 MINI_APP_ALLOW_PLACEHOLDER_ID=1 放行。",
  );
}

await copyFile("src/template.html", "dist/web/index.html");
await copyFile("src/strings.json", "dist/web/strings.json");

const files: Record<string, Buffer> = {};
for (const name of ["index.html", "app.js", "app.css", "strings.json"]) {
  files[name] = await readFile(`dist/web/${name}`);
}

for (const path of manifest.assets || []) {
  if (
    !/^[a-zA-Z0-9_.\-/]{1,160}$/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid package asset path");
  }
  files[path] = await readFile(`dist/web/${path}`);
}

// 包内 media 也必须写进 files：旧版这里只打了 assets，声明了 media 的
// 应用在 SDK pack 产物里会缺音视频文件，平台校验会报文件与 manifest 不符。
// 媒体文件放 public/media/，Vite 会把它拷到 dist/web/media/。
// 远程媒体（path 同时出现在 remote_assets 里）不进 ZIP，SDK pack 会处理它。
// manifest.json 本身不用写进 files，SDK 的 pack 会把它写进 ZIP 根目录；
// 无 SDK 的替代表 scripts/pack.mjs 则必须显式写 manifest.json，见该文件注释。
const remoteKeys = new Set(Object.keys(manifest.remote_assets || {}));
for (const decl of Object.values(manifest.media || {})) {
  if (!decl || typeof decl.path !== "string") continue;
  if (remoteKeys.has(decl.path)) continue;
  files[decl.path] = await readFile(`dist/web/${decl.path}`);
}

const result = await pack({ manifest, files, outputDirectory: "dist/package" });
console.log(
  `Created ${result.file} (${result.size} bytes), app ${manifest.id}, version ${manifest.version}`,
);
