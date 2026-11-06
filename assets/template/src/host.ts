import type {
  JsonValue,
  MiniAppSDK,
  MiniAppTheme,
  MiniAppUser,
  Permission,
} from "@discourse-mini-app/sdk";

/** 本模板用到的能力子集。 */
export type HostSDK = Pick<MiniAppSDK, "ready"> & {
  permissions: Pick<MiniAppSDK["permissions"], "has">;
  user?: Pick<MiniAppSDK["user"], "getCurrent">;
  theme?: Pick<MiniAppSDK["theme"], "get" | "onChange">;
  localStorage?: Partial<MiniAppSDK["localStorage"]>;
  lifecycle?: MiniAppSDK["lifecycle"];
};

export interface HostCallbacks {
  onNotice?: (text: string) => void;
  onTheme?: (theme: MiniAppTheme) => void;
  onIdentity?: (user: MiniAppUser | null) => void;
  onMode?: (mode: "preview" | "connected" | "guest" | "disconnected") => void;
}

/**
 * 把微应用接到平台能力上，且不让能力缺失阻断主流程。
 *
 * 三种降级：
 *   preview      本地开发，没有 SDK
 *   guest        平台里但匿名（用户为 null）
 *   disconnected 平台里但 SDK 不可用
 *
 * 任何一次能力调用失败都只发一条 notice，不抛错 —— 界面必须始终可用。
 */
export function createHost(
  sdk: HostSDK | null,
  messages: Record<string, Record<string, string>>,
  callbacks: HostCallbacks = {},
) {
  let locale = "zh_CN";
  let connected = false;
  let unsubscribe: (() => void) | null | undefined;
  let session:
    | { user: MiniAppUser | null; mode: "preview" | "connected" | "guest" | "disconnected" }
    | undefined;
  let writes: Promise<unknown> = Promise.resolve();

  /** 按当前语言取文案，缺失时回退 zh_CN，再缺失就用 key 本身。 */
  const t = (key: string, values: Record<string, unknown> = {}) =>
    (messages[locale]?.[key] ?? messages["zh_CN"]?.[key] ?? key).replace(
      /\{(\w+)\}/g,
      (_: string, name: string) => String(values[name] ?? ""),
    );

  const has = (permission: Permission) =>
    connected && !!sdk && sdk.permissions.has(permission);

  const report = (error: unknown) => {
    const code = (error as { code?: string })?.code || "UNAVAILABLE";
    callbacks.onNotice?.(t("apiError", { code }));
  };

  const applyTheme = (theme: MiniAppTheme) => {
    locale = Object.hasOwn(messages, theme.locale) ? theme.locale : "zh_CN";
    callbacks.onTheme?.(theme);
  };

  function showSession(
    user: MiniAppUser | null,
    mode: "preview" | "connected" | "guest" | "disconnected",
  ) {
    session = { user, mode };
    callbacks.onIdentity?.(user);
    callbacks.onMode?.(mode);
  }

  /** 跑一次能力调用；没有权限或失败时返回 fallback，绝不抛出。 */
  async function call<T, F = null>(
    permission: Permission,
    action: () => T | Promise<T>,
    fallback: F = null as F,
  ): Promise<T | F> {
    if (!has(permission)) return fallback;
    try {
      return await action();
    } catch (error) {
      report(error);
      return fallback;
    }
  }

  return {
    t,
    has,

    /** 连接 SDK。失败也要让界面继续可用。 */
    async connect() {
      unsubscribe?.();
      unsubscribe = null;
      if (!sdk) {
        showSession(null, "preview");
        return;
      }
      try {
        await sdk.ready;
        connected = true;
        if (has("theme.read")) {
          unsubscribe = sdk.theme?.onChange(applyTheme);
          const theme = await call("theme.read", () => sdk.theme!.get());
          if (theme) applyTheme(theme);
        }
        const user = await call("user.read", () => sdk.user!.getCurrent());
        showSession(user, user ? "connected" : "guest");
      } catch (error) {
        showSession(null, "disconnected");
        report(error);
      }
    },

    /** 读一个存储项。 */
    async load(key: string): Promise<JsonValue | null> {
      return call("storage.read", async () => {
        const value = await sdk!.localStorage!.getItem!(key);
        return value === null ? null : JSON.parse(value);
      });
    },

    /** 写一个存储项。串行化写入，避免并发覆盖。 */
    async save(key: string, value: JsonValue): Promise<boolean> {
      const snapshot = JSON.stringify(value);
      writes = writes.then(() =>
        call("storage.write", async () => {
          await sdk!.localStorage!.setItem!(key, snapshot);
          return true;
        }, false),
      );
      return writes;
    },

    /** 首屏渲染完成或已显示错误后调用一次。 */
    async rendered() {
      if (!sdk) return;
      try {
        await sdk.lifecycle?.ready();
      } catch (error) {
        report(error);
      }
    },

    /** 离开页面时清理订阅。 */
    dispose() {
      connected = false;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
