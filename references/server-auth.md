# 服务端鉴权

受保护 HTTP 和所有 WSS 接口都要验证平台 JWT。
用 `@discourse-mini-app/sdk/server`，**不要只解码 payload**。

HTTP 从 `Authorization: Bearer …` 读取；WSS 在 upgrade 前验证 `mini_app_token` query。

固定配置社区地址、服务 HTTPS origin、平台分配的应用 ID、环境和社区提供的
JWT 验证公钥；**不要按未验证请求里的地址选择公钥**。
此入口只用于 Node/Bun 服务端。

## 获取 JWT 验证公钥

```text
GET https://community.example.com/mini-app-api/jwks
```

如果社区部署在 `/forum` 子目录，地址是
`https://community.example.com/forum/mini-app-api/jwks`，
`issuer` 也必须包含 `/forum`，且不以 `/` 结尾。

这个 GET 接口不需要登录、API key 或 Cookie，即使社区要求登录也可以获取；
插件未启用时返回 404，JWT 公钥尚未正确配置时返回 503，需联系社区管理员。

```sh
curl --fail --silent --show-error \
  'https://community.example.com/forum/mini-app-api/jwks'
```

返回 JWKS JSON，`keys` 数组中有一把公钥：`kty: "EC"`、`crv: "P-256"`、
`alg: "ES256"`、`use: "sig"`、`kid`、`x`、`y`。
这是**开发者服务端验证 JWT 的公钥**，与微应用包验签公钥不同。
SDK 的 `publicKey` 参数可直接接收 JWK 对象，无需先转 PEM。

## 服务端接入示例

```ts
import type { JsonWebKey } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  PlatformAuthError,
  verifyPlatformRequest,
  verifyPlatformWebSocketRequest,
} from "@discourse-mini-app/sdk/server";

const issuer = "https://community.example.com/forum";

async function loadPublicKey(): Promise<JsonWebKey> {
  const response = await fetch(`${issuer}/mini-app-api/jwks`, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`JWKS request failed: ${response.status}`);
  const body = (await response.json()) as { keys?: JsonWebKey[] } | null;
  const key = Array.isArray(body?.keys) && body.keys.length === 1
    ? body.keys[0]
    : undefined;
  if (
    !key || key.kty !== "EC" || key.crv !== "P-256" ||
    key.alg !== "ES256" || key.use !== "sig" ||
    typeof key.kid !== "string" || !key.kid ||
    typeof key.x !== "string" || typeof key.y !== "string" ||
    Object.hasOwn(key, "d")
  ) {
    throw new Error("Invalid community JWKS");
  }
  return key;
}

const trust = {
  issuer,
  audience: "https://api.example.com",
  appId: "019a2a58-0000-7000-8000-000000000001",
  channel: "production" as const,
  publicKey: await loadPublicKey(),
};

function externalUrl(request: IncomingMessage) {
  if (!request.url?.startsWith("/")) throw new PlatformAuthError();
  return `${trust.audience}${request.url}`;
}

export function authenticateHttp(request: IncomingMessage) {
  return verifyPlatformRequest({
    ...trust,
    authorization: request.headers.authorization ?? "",
    scope: "network.request",
    method: request.method ?? "",
    url: externalUrl(request),
  });
}

export function authenticateUpgrade(request: IncomingMessage) {
  if (request.headers.origin !== new URL(trust.issuer).origin) {
    throw new PlatformAuthError();
  }
  return verifyPlatformWebSocketRequest({
    ...trust,
    url: externalUrl(request),
  });
}
```

替换上面的配置。URL 使用固定外部 origin 和原始 request target；
反向代理改写路径时按部署配置恢复，不信任任意 Host/转发头，
也不排序或重新编码 query。

## 公钥刷新

SDK **不会自动下载或刷新 JWKS**。生产服务应当：

- 在进程内缓存已信任公钥并定期刷新
- 遇到未知 `kid` 时可进行一次刷新（带冷却与并发合并）
- 仍无法验证则拒绝请求 —— **不要每条业务请求都下载公钥**
- 公钥轮换后重新获取对应公钥；若要让未过期的旧令牌继续使用，
  按 `kid` 暂存先前已信任的公钥，并限制保留时间

始终从配置中的固定社区地址取密钥，不能使用未验签 JWT 内的 `iss`、`jku`、
`jwk` 或 `x5u` 作为下载地址或信任来源。获取失败时**不能跳过验签**。

若管理员通过可信渠道提供 PEM 公钥，也可将其字符串传给 `publicKey`；
不要请求、保存或使用私钥。

## 响应约定

| 情形 | 状态码 |
| --- | --- |
| 验签失败 / JWT 缺失 / 无效 | 401 |
| 业务权限不足 | 403 |
| OPTIONS 预检 | 不要求 JWT |

- 身份使用验证结果的 `(iss, sub)`，**正文中的 `user_id` 不可信**。
- JWT 可复用 15 分钟，**不是一次性凭据**；仍需验证每次业务参数、资源归属和幂等。
- sandbox 要显式允许并与正式数据分开。
- **忽略 Cookie 鉴权**，JWT 缺失/无效不能回退登录态。
- HTTP 需允许论坛 origin 的 CORS、OPTIONS、Authorization、Content-Type；
  错误响应也要有 CORS，OPTIONS 不要求 JWT。
- WS 服务逐条验证业务消息；连接最多存活 `min(300 秒, token 剩余有效期)`，
  到期关闭并重新认证。
- 隐藏日志中的 `Authorization` 和 `mini_app_token`，不向微应用回显 token。
- 旧 JWT 可用到到期，业务封禁仍由服务端处理。

## 上线检查

- [ ] 公钥从固定配置的社区地址获取，未使用 JWT 内声明的密钥地址
- [ ] 公钥已缓存，不在每个请求下载
- [ ] 未知 `kid` 的刷新有冷却，不会打爆社区
- [ ] 验签失败返回 401 且**没有** Cookie 回退路径
- [ ] 业务权限不足返回 403，且按 `(iss, sub)` 判定资源归属
- [ ] 错误响应带 CORS 头
- [ ] 日志中无 `Authorization`、无 `mini_app_token`
- [ ] WS 连接在 token 到期时主动关闭
- [ ] sandbox 与正式环境的数据与权限分离
