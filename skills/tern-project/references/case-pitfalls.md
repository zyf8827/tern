# 用例编写踩坑录（来自真实项目实跑）

本页沉淀用例在真实环境执行时踩过的坑与规避模式。写用例遇到诡异失败时先对照本页；
新增踩坑也请记录到这里（症状 → 根因 → 规避写法）。

## 1. 资产引用必须是字符串字面量

**症状**：执行报 `ternAsset("images/x.png") 不在本次下发的资产中；可用: audio/a.wav, ...`
（错误里列出的可用资产恰好不含你引用的文件）。

**根因**：平台的资产引用扫描只识别**字符串字面量**调用 `ternAsset('path')`。把
`ternAsset` 包装进 `_lib` 共享函数内部、用参数传相对路径（如
`uploadFile(request, 'images/x.png')` → 函数内 `ternAsset(p)`），扫描看不见该引用，
文件不会随 run 下发到 worker。

**规避**：在**用例文件内**字面量调用拿本地路径，把 buffer/路径传给共享函数——

```ts
// ✅ 正确：字面量在用例源码里，扫描可见
const buf = readFileSync(ternAsset('images/idcard.png'));
const fileId = await uploadFile(request, 'idcard.png', buf); // _lib 函数收 buffer

// ❌ 错误：_lib 内部 ternAsset(assetPath)，字面量在调用参数里
const fileId = await uploadFile(request, 'images/idcard.png');
```

`_lib` 函数签名应声明「调用方负责 `ternAsset` 字面量解析」，不要提供接收相对路径
再内部解析的便捷封装（诱导反模式）。

## 2. antd 组件的断言姿势

- **Radio / Checkbox**：antd 把原生 input 做了视觉隐藏（靠 span 呈现），`toBeVisible()`
  对它必然失败（`Expected: visible Received: hidden`）。可见性断言用**文本**
  （`getByText('原始稿')`），选中态用 `toBeChecked()`（不要求可见）。
- **文案命中多处 → strict mode violation**（`resolved to 2 elements`）：页签名、提示语、
  按钮文案常重复出现。用 `.first()`（页签本体通常在前）或先定位容器再查文本。
- **弹窗内 Upload（rc-upload）**：Playwright `setInputFiles` 可能**不触发 onChange**
  （实测弹窗内场景，change 事件未派发、上传链路静默不启动）。改在页面上下文构造
  File 注入并派发事件，与真实用户选文件等价：

```ts
const buf = readFileSync(ternAsset('images/x.png'));
await page.evaluate((b64) => {
  const input = document.querySelector('.ant-modal input[type="file"]');
  if (!input) throw new Error('未找到上传 input');
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([arr], 'x.png', { type: 'image/png' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, buf.toString('base64'));
```

## 3. 设备模拟（devices）用例的环境前置

- **getUserMedia 要求 secure context**：`http://<IP>:<port>` 直连会被浏览器禁止
  （页面报「浏览器禁止不安全页面录音/拍照」→ 录音器卡「初始化中」→ 相关用例全体
  超时，且 REST 侧毫无异常，极具迷惑性）。`localhost` / `127.0.0.1` / HTTPS 天然安全。
- **平台已内建解决（F9 设备反向代理）**：worker 自动在本机 `127.0.0.1` 起 HTTP+WS
  双透传代理并重写运行参数（含 BASE_URL/API_BASE_URL 与 auth 登录，整链同源），
  对用例与环境配置完全透明；模式由平台设置 `device_proxy_mode` 控制
  （`auto` 默认按需 / `on` 强制 / `off` 禁用，Workers 页可切，run 创建时快照）。
  **环境值 BASE_URL 填被测系统真实地址即可**，执行日志会记「设备代理: 127.0.0.1:port → origin」。
- **旧版平台（无 F9）的兜底**：手动起本地反代并把环境 BASE_URL 指向
  `http://127.0.0.1:<port>`（需 HTTP 与 WebSocket upgrade 双透传，WS 必须回传上游
  101 + `Sec-WebSocket-Accept` 头）；Chromium flag
  `--unsafely-treat-insecure-origin-as-secure` 在部分 headless 版本被忽略，不要依赖。
- 推流文件规格对齐被测系统声明（如音频 WebSocket start 帧声明采样率 16k/mono/16bit）；前端有
  功率/音量检测阈值时注意样本振幅与静音段（参考合成测试资产 `_assets/`）。

## 4. 断言前先实探接口真实结构

- **前端 service 层的 JSDoc 可能与真实响应不符**（实测：文档写
  扁平数组列表，实际返回 `{groupList:[{groupId, items:[…]}]}`
  分组结构）。写断言前先用真实环境 `curl` 一次看结构，不要照前端代码注释写。
- 分组/嵌套结构建议在 `_lib` 提供展平函数（如 `flattenXxx`），用例统一在展平层取字段。
- 统一信封语义要核实：不少系统业务失败仍是 **HTTP 200 + `success:false`**（只有
  鉴权失败才是 401）——断言 `body.success` 而不是 HTTP 状态码。
- **单个端点可能本身就是坏的**（实测 `block/insert` 后端 NPE）：探测到等价端点
  （如同场景的 `batchInsert`）就改用等价端点，并在 `_lib` 注明原因；不要为迁就坏
  端点写脆弱 workaround。

## 5. 运行期注意事项

- `reuse: worker` 保证一个 run 内同一配方+账号只登录一次共享。**run 执行期间不要用
  同一账号手工登录**（每次登录换 token 会互踢 worker 会话，页面侧 401、用例诡异失败）。
  手工探测建议使用独立测试账号或等待 run 结束。
- **`retry-failed` 继承原 run 的参数快照**——修改环境值后要用**新 run** 验证，
  retry 不会读新值（实测：改了 BASE_URL 后 retry 仍打旧地址，重跑可能全数无效）。
- 页面 console 默认不进平台执行日志。定位页面侧问题（录音器失败、组件白屏）最快
  路径是本地临时脚本复现：`page.on('console')` + `page.on('pageerror')` +
  `page.on('websocket')` 帧转发，用与平台相同的启动参数（fake device flags）。
- 共享库（`_lib`）变更后 `sync` 会刷新受影响用例的 bundle（按产物 hash）；若发现
  「改了 _lib 但行为没变」，检查平台版本是否包含该修复（旧版只比对用例源码 hash）。
