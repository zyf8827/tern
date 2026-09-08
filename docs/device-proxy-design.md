# F9 设计：设备反向代理（Device Proxy）——HTTP 环境的 secure context 解决方案

> 状态：**已实施**（迁移 9 + 10；环境级配置：`environments.device_proxy`，
> 项目配置 → 环境页可改；worker DeviceProxyManager + 参数重写 + auth 同源；
> 单测 72 含 3 项代理透传；e2e [16.56] 段 8 项——内网 IP 直连失败/off 对照、
> 经代理通过、参数保持原始值断言、日志事件断言）。
> 前置：F8 测试资产与设备模拟（docs/test-assets-design.md）；多媒体用例在非安全源环境实跑验证。

## 1. 背景与问题

### 1.1 secure context 约束

Chromium 的 `getUserMedia`（麦克风/摄像头）只在 **secure context** 下可用：
`https://*`、`http://localhost`、`http://127.0.0.1` 天然安全；**`http://<IP或域名>:<端口>`
一律不安全**，`navigator.mediaDevices` 为 `undefined`。

被测系统（SUT）在私有环境多为 `http://<IP>:<端口>` 部署。device 用例
（`devices:` fake 麦克风/摄像头推流）打开这样的页面时，录音器初始化直接失败
（页面报「浏览器禁止不安全页面录音」，录音器永远卡「初始化中」），
**且 REST 侧毫无异常**——device/UI 用例超时雪崩而 API 用例全绿，极具迷惑性。

### 1.2 已排除的方案

| 方案                                                                | 结论                         | 证据                                                                                                                                                                               |
| ------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium flag `--unsafely-treat-insecure-origin-as-secure=<origin>` | **不可靠，弃用为主方案**     | Playwright 1.59 headless 实测 5 种传值形式（带/不带端口、无 scheme、通配、带路径）全部无效，`isSecureContext` 恒 false；有头模式因无显示器无法验证。社区多报 headless=new 下被忽略 |
| 要求 SUT 上 HTTPS                                                   | 运维成本高，内网环境普遍没有 | ——                                                                                                                                                                                 |
| 本地反向代理 `127.0.0.1:<port> → <SUT>`                             | **可行，已实跑验证**         | HTTP + WebSocket upgrade 双透传，用例全链路（登录/页面/REST/WS 推流/数据处理）跑通                                                                                                 |

已验证的代理要点（实现必须保留）：

1. **HTTP 透传**：请求原样转发，`Host` 头重写为目标 host（部分网关校验 Host）；
2. **WS 透传**：upgrade 请求转发后，**等目标返回 101 + 握手响应头（含
   `Sec-WebSocket-Accept`）原样回写客户端**，再双向 pipe——不能自己伪造 101；
3. 只监听 `127.0.0.1`；
4. 整链同源：登录配方、页面、API、WS 全走代理 origin，cookie 域自然一致
   （只代理页面不代理登录会导致 cookie 域不匹配，实测踩过）。

### 1.3 现状痛点

当前方案是**临时外部脚本**（本次验证用的 /tmp 手写 proxy.mjs）：

- 需要人工启动、人工把环境 BASE_URL 改成代理地址；
- 平台对「BASE_URL 指向哪里」与「实际可达性」无感知，device 用例失败时排障成本高；
- 换机器/换环境要重复搭建。

**结论：反代应成为平台能力**——manage 侧可配置开关，worker 侧自动执行，
用例与环境配置零改动。

## 2. 目标与非目标

**目标**

- G1：device 用例对 `http://<IP>` SUT 开箱即用，无需任何外部脚本/改环境值；
- G2：manage（server）侧按**环境**配置代理模式：`auto`（默认，按需）/ `on`（强制）/ `off`（禁用）——
  「是否需要反代」属于环境（BASE_URL 怎么被访问）的属性，随环境走而非全局；
- G3：对用例与用例仓库**完全透明**：tern.yaml、用例代码、环境值都不需要知道代理存在
  （环境的 BASE_URL 等值**始终是原始值**，改写只发生在 worker 执行侧）；
- G4：多 worker 各自本地代理（localhost 是每机概念）；同 worker 并发 run 复用同一代理；
- G5：可观测：run 详情与执行日志能看到「代理已启用：127.0.0.1:port → origin」。

**非目标**

- 不做 HTTPS 目标的中间人解密代理（https SUT 本来就是 secure context，无需代理；
  若未来需要测 https SUT 的改包场景，走 CONNECT 隧道另立设计）；
- 不做跨机共享代理（代理只在 worker 本机有意义）；
- 不代理 page.request 直连其他第三方域的流量（只按「不安全 origin 前缀」重写
  运行参数中声明的地址类变量）。

## 3. 方案总览

```
┌─────────────────────── Tern server (manage) ───────────────────────┐
│ environments.device_proxy = auto|on|off（项目配置 → 环境页可改）     │
│ createRun：环境快照进 batch → assignRun 经 AssignTask.deviceProxy 下发│
└──────────────────────────────┬──────────────────────────────────────┘
                               │ assign（含 deviceProxy + params，params 保持原始值）
┌──────────────────────────────▼──────────────────────────────────────┐
│ worker                                                             │
│  handleAssign:                                                     │
│    mode=off → 直连（现状）                                          │
│    mode=on/auto 且 params 中存在 http 非安全 origin →               │
│      DeviceProxyManager.acquire(origin) → http://127.0.0.1:<port>  │
│      重写参数值前缀 → exec-kit（browser 打开 127.0.0.1 页面）        │
│  DeviceProxyManager: origin→http.Server 懒启动复用，worker 退出销毁  │
└─────────────────────────────────────────────────────────────────────┘
```

判定函数（与 exec-kit F8 的 `insecureOrigin` 保持同一份语义，抽到 sdk 复用）：

```
需要代理(mode) = mode==='on' ? (BASE_URL 为 http:// 且非 localhost)
                 : mode==='auto' ? 同上
                 : false
```

## 4. 详细设计

### 4.1 配置模型（server，环境级）

- 迁移 10：`environments` 表新增 `device_proxy TEXT`（存量回填 `auto`）；
  迁移 9 曾引入的 `platform_settings` 全局设置表随之退役（DROP）；
- 取值（allowlist，非法回落 `auto`）：`auto` | `on` | `off`，默认 `auto`；
- API（随环境 CRUD，走既有环境鉴权）：
  - `POST /api/v1/projects/:id/environments` body 可带 `deviceProxy`；
  - `PATCH /api/v1/projects/:id/environments/:envName` body `{ deviceProxy: 'on' }`
    （可单独改，不动值集）；
  - 环境列表/详情回显 `deviceProxy`；
- Web：环境编辑表单（项目配置 → 环境）内一个下拉 + 说明文案，环境卡片显示当前模式：
  - auto（推荐）：运行参数含 http 内网地址时自动经本机反代访问
  - on：强制经反代（调试代理链路用）
  - off：禁用（device 用例在 http 内网地址下预期失败）；
- CLI（可选，v1 不做）：`tern env set-proxy`。

### 4.2 协议与数据流（sdk / server / worker）

- `AssignTask` 增加 `deviceProxy?: DeviceProxyMode`（server 在 createRun 时读环境的
  device_proxy 快照进 batch（`batches.device_proxy`），assignRun 只读快照——保证 run
  内一致、可复现；历史 NULL 批次回落 auto）；
- worker `handleAssign`：

```ts
const mode = msg.deviceProxy ?? 'auto';
const rewrite = rewriteInsecureParams(params, mode);
// rewriteInsecureParams：扫描 params 每个值，形如 http://<host>:<port>... 且
// host 非 localhost/127.0.0.1/[::1] 时：
//   const proxy = await deviceProxyManager.acquire(origin);
//   值前缀 origin → proxy.origin（保留 path/query）
// 返回 { params, applied: [{ from, to }] }（进执行日志与 run 事件）
```

- 重写范围 = **所有运行参数的值**（不止 BASE_URL）：`API_BASE_URL` 等地址类变量
  一并覆盖（G3 透明的关键——用例与配方读到的就是可用的地址）；
- auth 登录在 worker 侧先于用例执行，用的就是重写后的 BASE_URL →
  cookie 域即代理 origin → 页面同源，无需任何特殊处理；
- 执行日志记一条 info 事件：`设备代理: http://127.0.0.1:9310 -> http://10.0.1.20:3000`；
  run 详情（Web/MCP get_run）附 `deviceProxyApplied` 字段。

### 4.3 Worker：DeviceProxyManager

```ts
class DeviceProxyManager {
  private servers = new Map<string /* targetOrigin */, Promise<ProxyHandle>>();

  acquire(targetOrigin: string): Promise<{ origin: string; close(): void }>; // 引用计数
  release(targetOrigin: string): void;
  async closeAll(): void; // worker 退出钩子
}
```

实现要点（把已验证的 proxy.mjs 代码产品化）：

- 每个 targetOrigin 一个 `http.Server`，`listen(0, '127.0.0.1')` 取随机端口；
- HTTP：`http.request` 转发，`headers.host` 重写为目标 `host:port`，响应头/体 pipe 回；
  上游错误回 502（带目标 origin 便于排障）；
- WS：`server.on('upgrade')` → `net.connect` 目标 → 转发 upgrade 请求（Host 重写）→
  **缓冲上游数据直到读到 `\r\n\r\n`，将 101 响应头 + 已缓冲字节原样回写客户端** →
  双向 pipe（保留 `Sec-WebSocket-Accept`，不能伪造 101）；
- 引用计数归零后不立即关（避免同 origin 反复启停），注册 `worker.beforeExit` 统一
  `closeAll()`；可选 idle GC（>30min 无连接关闭，v1 不做，Map 占用可忽略）；
- acquire 失败（端口耗尽等）→ run 直接失败，错误信息含目标 origin。

放置位置：`apps/worker/src/device-proxy.ts`（纯 Node 无三方依赖，不进 exec-kit——
exec-kit 保持「单用例执行器」边界，代理是 worker 的运行环境职责）。

### 4.4 exec-kit / 用例仓库

- **零改动**。`deviceLaunchArgs` 既有的 `--unsafely-treat-insecure-origin-as-secure`
  兜底保留（BASE_URL 已是 127.0.0.1 时自然不触发）；
- 用例、tern.yaml、环境值（BASE_URL 保持填 SUT 真实地址）都不感知代理——
  环境值填**真实地址**反而是正确姿势（报告/钉钉里的链接可直接访问）。

### 4.5 安全考量

- 代理仅绑定 `127.0.0.1`，不暴露局域网；
- 不解析/不缓存 body，纯字节透传；
- 目标 origin 白名单不需要（来源是运行参数，本就受环境管理控制）；
- 代理不添加任何鉴权头（原样透传 SUT 自己的鉴权体系）。

## 5. 测试计划

- **单测**（`apps/worker/src/device-proxy.test.ts`）：
  - 起本地双端：目标 http server（含一条 upgrade WS echo）→ acquire 代理 →
    断言 HTTP 转发（Host 重写、响应体一致）与 WS 握手（101 头透传、双向帧）；
  - `rewriteInsecureParams`：http+IP 重写 / localhost 与 https 不动 / path 保留 /
    非 URL 值不动 / off 模式直通；
- **e2e**（scripts/e2e-test.mjs 增段）：
  - demo-site 绑定到宿主机内网 IP（而非 127.0.0.1），PATCH 环境 `deviceProxy=on`，
    跑一条 device 用例：断言执行日志出现代理事件、页面 `isSecureContext=true`
    （用例内 evaluate 断言）、录音正常产出，且 run 参数 BASE_URL 保持原始值；
  - 环境 `off` 下同用例预期失败（负向对照，验证开关生效）；
- 回归：现有 69 条单测 + e2e 全绿。

## 6. 边界与后续

- https 目标不需要也不走代理；若 SUT 是「页面 https 但 WS 直连内网 IP」的混合形态
  （secure context 按顶层页面判定，不受影响）无需处理；
- 未来 worker 容器化部署：容器内 localhost 即容器自身，浏览器与代理同容器，天然成立；
- DingTalk 通知里的 SUT 链接使用原始 BASE_URL（未重写值保留在 batch.params 展示层）；
- 后续可选：设置项下沉到项目级/环境级覆盖（平台级先满足全部已知场景）。

## 7. 实施清单

| #   | 位置                                                                         | 内容                                                    | 量级 |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------- | ---- |
| 1   | sdk types                                                                    | `AssignTask.deviceProxy`、run 详情 `deviceProxyApplied` | 小   |
| 2   | server migrations 9 + settings 路由 + assignRun 解析下发 + batch 快照        | 中                                                      |
| 3   | server Web WorkersPage 设置组件                                              | 小                                                      |
| 4   | worker `device-proxy.ts`（Manager + 透传实现）+ handleAssign 重写 + 日志事件 | 中（核心）                                              |
| 5   | 单测 + e2e 段                                                                | 中                                                      |
| 6   | docs（本文档定稿）+ AGENTS/skill pitfall §3 更新为「平台自动反代」           | 小                                                      |
