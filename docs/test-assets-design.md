# 测试资产与多媒体设备方案（F8 · v3：repo 资产 + manage→worker 下发）

> 状态：设计稿 v3。按「**测试文件资源在用例 repo 内打包、脚本内引用、随任务下发到 worker**」设计，媒体设备作为资产的重要消费场景。
> 通用目标：平台提供**一个**通用文件原语，优雅适配一切场景（音频推流 / API 播种 / 上传 fixture / 数据对比）；
> 典型业务目标：覆盖多媒体应用核心链路——实时语音识别（ASR）、精炼分析、问答抽取与数据比对。

## 0. 多媒体前端业务链路架构

```
getUserMedia(麦克风) ──PCM 分帧──▶ WS 上行（流式协议）
                                    opCode: start(声明 samplingRate/pcm) / send(blob 帧)
                                    / pause / resume / stop / edit
                                    / opt_analysis / opt_qa
                                 ▼
                            后端流式 ASR + 文本分析 + QA
                                 ▼
WS 下行：ASR_RESULT(渐进上屏) / ASR_BLOCK_* / OPT_ANALYSIS_RESULT / OPT_QA_LIST
```

关键结论：**浏览器侧只依赖 getUserMedia 产出真实 PCM**，其余（流式上传、识别、分析）全是被测系统前端代码。因此模拟只需发生在麦克风这一个硬件边界（Chromium fake device），或完全绕开浏览器（API 播种）。

## 1. 通用机制：项目资产（assets）——平台唯一的文件原语

**原则：平台做 O(1) 的机制，场景做 O(n) 的薄适配。** 所有要"文件跟着用例走"的场景共用一条通道，不按场景各造传输。

### 1.1 repo 内打包

```
cases/
  _assets/                       # 专用资源目录（复用 `_` 前缀不参与调度惯例；tern.yaml 可选 assetsDir: 覆盖）
    audio/
      interview-qa-16k.wav       # 问答对话样本（问答识别场景）
      interview-mono-16k.wav     # 单人陈述样本（文本转写场景）
      interview-qa-16k.expected.json   # 与样本配对的断言数据（预期关键词/问答对）
    upload/
      id-card.png                # 上传类用例的通用 fixture
  _lib/                          # 用例共享工具（现有惯例）
```

- **资产即场景 fixture 包**：媒体样本与其**预期断言数据配对存放**（`xxx.wav` + `xxx.expected.json`），改样本必须连带改断言——一次 commit 表达一个完整测试输入，可评审、可回滚；
- 单文件上限 64MB（`ASSET_MAX_BYTES` 可配）；git 侧建议短样本（16k mono PCM ≈ 2MB/分钟），后续 git-lfs 天然兼容（sync 读工作区文件）；
- 不是环境变量：换环境值不变的是 fixture，随仓库版本化（沿用既定判定规则）。

### 1.2 同步（sync）

scan `assetsDir/**` → sha256 → 拷入 `data/assets/<hash前2>/<hash>`（内容寻址，同 bundle 机制，改动自动去重）→ `assets` 表；仓库中消失 → 标记 deleted。sync 报告含资产增删。WAV 文件头校验（RIFF/WAVE）供 devices 场景 fail-fast。

### 1.3 manage→worker 传输（复用 bundle 通道模式）

```
createRun：解析选中用例引用的资产（frontmatter devices + 用例内 ternAsset() 静态引用）
           → hash 快照进 batch scope
assignRun：AssignTask 增 assets: [{ path, hash, url, bytes }]
worker   ：ensureAsset(hash, url) → runsDir/assets/<hash> 本地缓存，命中不下载（同 ensureBundle）
           任务资产缺失（server 无该 hash）→ 该执行按 error 失败并说明缺哪个文件（fail-fast）
```

- 端点：`GET /api/v1/assets/:hash`（worker token 鉴权 + hash 格式校验，同 bundles 防穿越做法）；
- 缓存永久有效（内容寻址）；清理走 worker 重启策略，不额外做 LRU。

### 1.4 用例内引用（关键接口设计）

runner 的 case 包装器（prologue，auth 注入同源机制）注入**全局函数**，用例零 import：

```ts
test('问答识别 - 对话样本转写并生成问答列表', async ({ page }) => {
  const wavPath = ternAsset('audio/interview-qa-16k.wav'); // → worker 本地绝对路径
  const expected = JSON.parse(
    readFileSync(ternAsset('audio/interview-qa-16k.expected.json'), 'utf8'),
  );
  await page.goto('/audioRecordPage?...');
  await page.locator('#start-record').click(); // fake mic 开始"播"样本
  await expect(page.locator('.transcript')).toContainText(expected.keyword, { timeout: 120_000 }); // ASR_RESULT 渐进上屏
});
```

- `ternAsset(relPath)`：prologue 定义 `globalThis.ternAsset`，从 `TERN_ASSETS` 环境变量（path→本地路径的 JSON 映射，runner 注入）查表；未引用/未下发的路径 → 明确报错列出可用资产；
- 静态引用收集：esbuild 打包时扫描 AST 中的 `ternAsset('...')` 字面量调用（与 import 白名单同趟遍历），引用不存在的资产 → sync invalid（fail-fast，同 lint 风格）；
- 兜底：`process.env.TERN_ASSETS` 直接可用（不依赖全局函数的场景，如 node 侧逻辑）。

## 2. 消费场景（薄适配层）

### 2.1 devices：fake 麦克风/摄像头（服务"录音流程"用例）

frontmatter（用例级）+ run options 覆盖（全 run 换样本）：

```yaml
/**
 * @tern
 * title: 录音 - 真实音频全流程（识别→分析→问答）
 * devices:
 *   mic: audio/interview-qa-16k.wav     # 相对 assetsDir；数组形式 [mic] = 仅假设备默认音
 */
```

执行：devices 引用解析为 hash（sync 已 lint 存在性/WAV 头）→ 随任务下发 → exec-kit 在生成的 playwright.config `launchOptions.args` 注入：

```
--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
--use-file-for-fake-audio-capture=<worker 本地 WAV 绝对路径>
[--use-file-for-fake-video-capture=<y4m>]（可选）
```

fake device 以**实时速率**播放样本 → getUserMedia 产出真实 PCM → 页面既有代码分帧上行 WS → 后端真实处理。前端的设备检测（`enumerateDevices` 探测）也能顺利通过：fake 设备会出现在设备列表。

### 2.2 API 播种（服务"后续流程"用例，零新增机制）

大多数用例只需"业务记录已存在"：

```ts
const res = await page.request.post('/api/voice/task/upload', {
  multipart: {
    file: {
      name: 'seed.wav',
      mimeType: 'audio/wav',
      buffer: readFileSync(ternAsset('audio/interview-mono-16k.wav')),
    },
  },
});
const taskId = (await res.json()).data.taskId;
```

`ternAsset` + 既有 `page.request`（共享登录态）即成——不需要麦克风、不需要浏览器录音控件，后端链路全真。

### 2.3 通用上传/数据 fixture

非音频场景直接受益：上传证件照用例引用 `upload/id-card.png`、批量数据比对引用 JSON——同一通道，无专属开发。

## 3. 多媒体典型场景矩阵（机制选型）

| 场景                                  | 链路要点                               | 机制                                             | 断言范式                                                                                  |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **实时识别上屏**                      | fake mic 实时推流 → WS 分帧 → 渐进渲染 | devices: mic=单人说稿样本                        | `expect(locator).toContainText(关键词)`（渐进到达，长 timeout）+ 停录后比对 expected.json |
| **精炼文本生成**                      | 识别完成后触发后端分析 → 回推渲染      | devices 全流程 或 **API 播种 + UI 触发**（推荐） | 触发按钮后 `expect.poll` 分析区非空/含关键词                                              |
| **智能抽取推荐**                      | 后端抽取推荐列表渲染                   | 播种数据 → UI 触发                               | 推荐列表出现且条目数/关键词符合 expected                                                  |
| **问答列表抽取**                      | 结构化问答提炼                         | 同上；问答结构来自问答对话样本                   | 问答对数量与首问关键词断言                                                                |
| 录音控件状态流（开始/暂停/停止/重连） | 前端状态切换                           | devices: [mic]（默认音即可）                     | 控件状态类名/文案断言                                                                     |
| 业务后续全流程                        | 无需录音                               | API 播种                                         | 常规 UI 断言                                                                              |

**WS 用例范式**（skill 沉淀，平台无需新机制）：断言的是 WS 驱动的 DOM，不断言 WS 报文本身——渐进文本用 `toContainText` 轮询天然契合；`expect.poll(fn, { timeout })` 覆盖"处理完成"类状态；识别场景 frontmatter `timeout` 建议 ≥ 300s。

## 4. 数据模型与改动清单

```sql
-- migration 8
CREATE TABLE assets (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,                 -- 相对 assetsDir
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);
CREATE INDEX idx_assets_hash ON assets(hash);
```

| 模块           | 职责                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| case-bundler   | frontmatter `devices` 解析；`ternAsset('...')` 字面量扫描进引用清单（lint 存在性）                     |
| server sync    | assets 目录扫描/入库/增删报告；devices 与 ternAsset 引用 lint                                          |
| server api     | `GET /api/v1/assets/:hash`（worker 鉴权）                                                              |
| server runtime | createRun 汇总用例资产引用 → hash 快照；assignRun 附 `assets`                                          |
| worker         | `ensureAsset` 下载缓存；`TERN_ASSETS` 注入 runner 环境                                                 |
| exec-kit       | prologue 注入 `globalThis.ternAsset`；config 模板 launchOptions.args 按 devices 注入 fake-device flags |
| sdk            | `AssignTask.assets`、`RunOptions.devices`、CaseMeta.devices 类型                                       |
| CLI/MCP/Web    | `tern assets list`、`tern_list_cases` 展示 devices/资产                                                |

## 5. 风险与边界

| 风险                        | 应对                                                                             |
| --------------------------- | -------------------------------------------------------------------------------- |
| WAV 进 git 尺寸             | 上限 64MB + 短样本建议 + git-lfs 兼容；样本库控制在合理文件数                    |
| fake 设备名与真实不同       | fake 设备会出现在列表（label 为 Fake Audio Input）；若前端白名单校验设备名需放宽 |
| 真实处理延迟导致用例慢/波动 | timeout 放宽 + 关键词级断言（不比对全文）+ expected 注明样本时长；flaky 治理兜底 |
| 采样率不匹配页面声明        | 样本规范 16k/mono 与页面一致；lint 校验 WAV 头读出采样率并 warn                  |
