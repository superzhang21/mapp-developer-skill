import { getSDK } from "@discourse-mini-app/sdk";
import { createHost } from "./host";
import strings from "./strings.json";

/**
 * 入口。
 *
 * 关键顺序：连接 SDK → 渲染首屏 → 调用 lifecycle.ready()。
 * lifecycle.ready() 只能调一次，且必须在首屏已可见（或已显示错误）之后，
 * 否则框架会一直显示空白；过早调用则会把真实错误藏起来。
 */

/** 本地预览没有注入 SDK，getSDK() 会抛错 —— 降级为 preview 模式。 */
function getSDKSafe() {
  try {
    return getSDK();
  } catch {
    return null;
  }
}

const root = document.getElementById("app");
const titleEl = document.getElementById("title");
const statusEl = document.getElementById("status");
const userEl = document.getElementById("user");
const noticeEl = document.getElementById("notice");

const MODE_TEXT: Record<string, string> = {
  preview: "本地预览",
  connected: "已登录",
  guest: "访客模式",
  disconnected: "连接中断",
};

const host = createHost(
  getSDKSafe(),
  strings as unknown as Record<string, Record<string, string>>,
  {
    onNotice(text) {
      if (noticeEl) noticeEl.textContent = text;
    },
    onTheme(theme) {
      // 平台切换深浅主题时同步 CSS 变量。
      document.documentElement.dataset.mode = theme.mode;
      document.documentElement.dataset.motion = theme.reducedMotion ? "reduced" : "full";
    },
    onIdentity(user) {
      if (userEl) userEl.textContent = user ? user.name : host.t("guest");
      if (user?.avatarUrl && root) {
        const avatar = document.getElementById("avatar");
        if (avatar) {
          avatar.src = user.avatarUrl;
          avatar.alt = user.name;
        }
      }
    },
    onMode(mode) {
      if (statusEl) statusEl.textContent = MODE_TEXT[mode] ?? mode;
    },
  },
);

if (titleEl) titleEl.textContent = host.t("title");

// 先连接（拿主题和用户），再渲染首屏，最后通知平台。
host
  .connect()
  .catch(() => {
    /* connect 内部已处理错误，这里不重复处理 */
  })
  .then(() => host.rendered());

window.addEventListener("pagehide", () => host.dispose());
