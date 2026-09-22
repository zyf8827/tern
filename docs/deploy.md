# 部署指南（Docker）

平台由两类容器组成：

| 镜像          | 基础镜像                                     | 说明                                                                          |
| ------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| `tern-server` | `node:22-bookworm-slim`                      | Fastify Server + SQLite + Web 管理端静态资源                                  |
| `tern-worker` | `mcr.microsoft.com/playwright:v1.59.0-jammy` | Playwright 官方镜像（浏览器与 `@playwright/test` 版本严格一致）+ **中文字体** |

> Worker 基础镜像的版本必须与 `apps/worker/package.json` 中 `@playwright/test` 版本一致（`scripts/docker-build.sh` 会自动校验），否则 Server 会在握手阶段拒绝该 Worker。注意：部分 Playwright 版本仅提供 `jammy` 变体（如 v1.59.0），无 `noble`，可通过 `PLAYWRIGHT_IMAGE` 环境变量调整。

## 1. 初始化部署配置（init-compose）

`docker-compose.yml` 与 `.env` 是**按机器生成的实例文件**（均已 gitignore，不入库），仓库内只保留模板 `docker-compose.example.yml` 与 `.env.example`：

```bash
bash scripts/init-compose.sh          # 交互问答：端口/worker 副本数/并发槽/WORKER_TOKEN 等，回车 = 默认值
bash scripts/init-compose.sh --yes    # 或非交互全默认（CI/脚本可用）；再次运行以当前 .env 为默认值沿用配置
```

- `WORKER_TOKEN` 默认生成随机值，无需手填；
- `PUBLIC_URL`（对外访问地址）默认**自动探测宿主机局域网 IP + 端口**拼出——钉钉通知等消息里的「查看详情」链接用它拼，缺省时链接会指向 `localhost` 导致群里点不开；
- 生成后**改 `.env` 即可**换端口（`SERVER_PORT`）、副本数（`WORKER_REPLICAS`）、并发槽（`WORKER_MAX_SLOTS`）等，无需重新 init；
- 也可手工 `cp .env.example .env`、`cp docker-compose.example.yml docker-compose.yml` 后修改。

## 2. 构建镜像

所有镜像构建默认使用官方上游源（Debian、npm）。在中国大陆网络环境下构建，可通过 build-arg 或 `.env` 启用国内镜像加速：

| 变量                       | 可选国内源示例                                            | 说明                                              |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `APT_MIRROR`               | `mirrors.aliyun.com`（或 `mirrors.tuna.tsinghua.edu.cn`） | apt 镜像源（默认官方源）                          |
| `NPM_REGISTRY`             | `https://registry.npmmirror.com`                          | npm registry（默认 `https://registry.npmjs.org`） |
| `PLAYWRIGHT_DOWNLOAD_HOST` | `https://npmmirror.com/mirrors/playwright`                | 浏览器二进制下载（默认官方源）                    |

```bash
bash scripts/docker-build.sh  # 构建两个镜像（自动校验 playwright 版本一致性）
```

或直接用 compose 构建：

```bash
docker compose build
```

### 源码热替换（开发调试，不需重建镜像）

init-compose 选择开启（或手工取消 `docker-compose.example.yml` 中热替换挂载行注释）后，宿主机构建产物会覆盖容器内对应目录，日常改代码**不需要重新 docker build**：

| 宿主机（构建产物）                   | server 容器                                 | worker 容器                             |
| ------------------------------------ | ------------------------------------------- | --------------------------------------- |
| `apps/server/dist`                   | `/app/dist`                                 | —                                       |
| `apps/server/public`（web 构建产物） | `/app/public`                               | —                                       |
| `apps/worker/dist`                   | —                                           | `/app/dist`                             |
| `packages/sdk/dist`                  | `/app/node_modules/@tern/sdk/dist`          | 同左                                    |
| `packages/case-bundler/dist`         | `/app/node_modules/@tern/case-bundler/dist` | —                                       |
| `packages/exec-kit/dist`             | —                                           | `/app/node_modules/@tern/exec-kit/dist` |

流程（要求宿主机有 Node/pnpm 环境）：

```bash
pnpm install && pnpm -r build     # 首次：构建全部产物（web 产物输出到 apps/server/public）
docker compose up -d              # 首次启用挂载后需 up -d 重建容器
# 日常改代码后：
pnpm -r build && docker compose restart server worker
```

说明：

- 只挂载 **dist 等编译产物**，纯 JS 更新，无原生模块 ABI 问题（`better-sqlite3` 等原生依赖仍用镜像内编译好的版本）；
- `trace-viewer` 仍随镜像（版本与镜像内 playwright-core 锁定），不随宿主机构建变化；
- 宿主机缺少产物时 init-compose 会告警：挂载空目录会导致服务起不来，先执行 `pnpm install && pnpm -r build`。

## 3. 启动

```bash
docker compose up -d                          # 1 server + WORKER_REPLICAS 个 worker
docker compose up -d --scale worker=3         # 临时扩容到 3 个 worker（改 .env 的 WORKER_REPLICAS 则持久生效）
docker compose logs -f server worker
curl http://127.0.0.1:7430/api/v1/meta
```

挂载与数据（宿主机路径可在 `.env` 的 `HOST_DATA_DIR` / `HOST_REPOS_DIR` 配置，默认仓库根下 `./data`、`./repos`）：

- `$HOST_REPOS_DIR → /app/repos`：用例项目仓库根目录。**用例项目在 Web「项目」页添加 git 地址**（默认 HTTP 账号密码，可选 SSH 私钥；容器内不会使用宿主机 `~/.ssh`。server 自动 clone 并按 `PULL_INTERVAL_SEC`（默认 300s）强制拉取：`fetch + reset --hard + clean -fdx`）；也可以把含 `tern.yaml` 的目录手工放进该目录（自动发现注册，本地修改约 2s 后自动同步）。容器以 root 运行 git，compose 已通过 `GIT_CONFIG_*` 环境变量放开 `safe.directory`，映射宿主机已有仓库（属主非 root）不会报 dubious ownership。用例的修改在各自的 git 仓库进行（人或 Coding Agent push 后，页面点「更新」或等自动拉取）。
- `$HOST_DATA_DIR → /app/data`：SQLite（`platform.db`）、bundle 缓存、执行产物（trace/截图/日志），worker 的执行 scratch 也落在其 `runs/` 子目录。备份 = 停服拷贝该目录。compose 已显式设置容器内 `DATA_DIR=/app/data` 对准挂载点。

## 4. 中文字体（Worker 镜像重点）

Worker 镜像基于 Playwright 官方镜像（其默认**不含中文字体**，中文页面会渲染为方块/乱码），已在镜像内额外安装并刷新字体缓存：

- `fonts-noto-cjk` / `fonts-noto-cjk-extra`：Noto Sans/Serif CJK，简繁日韩全量覆盖（首选）
- `fonts-wqy-microhei` / `fonts-wqy-zenhei`：文泉驿（老站点常用回退）
- `fonts-droid-fallback`：Droid Sans Fallback
- `fonts-noto-color-emoji`：彩色 emoji

构建期自检：`RUN fc-list :lang=zh | wc -l` 必须大于 10，否则构建失败。

验证容器内字体：

```bash
docker run --rm tern-worker:latest fc-list :lang=zh | head
```

如需额外字体（如仿宋、楷体、思源黑体特定字重），在 `docker/worker.Dockerfile` 的 `apt-get install` 列表追加（如 `fonts-arphic-ukai fonts-arphic-uming`）后重新构建。

## 5. 常用运维

```bash
# 扩容/缩容 worker
docker compose up -d --scale worker=5

# 查看实时日志
docker compose logs -f worker

# 重启（用例项目变更由自动拉取/页面更新生效，无需重启；改 .env 后需 recreate）
docker compose up -d --force-recreate

# 升级平台：改代码后重新构建并滚动替换
# SQLite schema 会在 server 启动时自动迁移，无需人工操作；
# 升级前可先检查: docker compose run --rm --no-deps server node dist/migrate-cli.js status
bash scripts/docker-build.sh && docker compose up -d --build
```

健康检查：Server 内置 `HEALTHCHECK`（`/api/v1/meta`），worker 通过 `depends_on: condition: service_healthy` 保证在 Server 就绪后接入。

## 6. 远程 / 多机 Worker

Worker 无需访问用例仓库，只要能出站访问 Server 即可部署在任意机器：

```bash
docker run -d --name tern-worker \
  --shm-size 1gb \
  -e SERVER_URL=http://<server-host>:7430 \
  -e WORKER_TOKEN=<与 server 一致> \
  -e MAX_SLOTS=1 \
  --restart unless-stopped \
  tern-worker:latest
```

`--shm-size 1gb`（或 `--ipc=host`）为 Chromium 推荐配置，避免大页面下共享内存不足导致崩溃。

## 7. 安全提示

- `WORKER_TOKEN` 泄漏等于允许任意机器接入执行任务，生产环境请使用强随机值；
- 平台定位为内网工具，请勿将 Server 直接暴露公网；如需最小防护可设置 `API_TOKEN` 环境变量（写操作要求 Bearer 认证）；
- Worker 会执行用例库中的代码，请仅部署在可信环境（必要时叠加容器隔离策略）。

## 8. 数据库后端

Tern 默认使用内置 SQLite（文件保存在挂载的数据卷 `$HOST_DATA_DIR/platform.db` 中）。如需接入外置 MySQL 或 PostgreSQL 数据库，可通过配置环境变量实现（`docker-compose.yml` 中的 default compose 配置保持以 SQLite 为主，若使用 MySQL/PG 请外置部署并配置到 `server` 环境变量）。

- **DB_DIALECT**：数据库方言，可选值为 `sqlite`（默认）、`mysql`、`postgresql`。
- **DB_PATH**：当使用 `sqlite` 时，指定 `.db` 文件路径，默认指向数据目录下的 `platform.db`。
- **DATABASE_URL**：MySQL 或 PostgreSQL 的完整连接字符串。
- 也可以通过离散的 **DB_HOST**、**DB_PORT**、**DB_USER**、**DB_PASSWORD**、**DB_NAME** 进行配置。

> **注意**：
> - 数据库相关的环境变量仅供 Server 端使用（包括 `migrate-cli` 进行迁移时也共用此套配置）；Worker 端无数据库直连，无需配置这些参数。
> - **测试覆盖度提示**：Tern 的单元测试目前主要覆盖 SQLite 分支。对于 MySQL/PG，底层使用 Worker 异步桥接来保证多环境一致，但强烈建议在生产应用前，自行连接真实的外置数据库实例进行预演测试。
