# Tern 登录配方（auth）完整参考

登录流程不写进用例，统一在用例仓库 `tern.yaml` 的 `auth:` 下声明（配方较长可拆到仓库根 `auth.yaml`，存在时**整段覆盖** `tern.yaml` 的 `auth`）。Worker 执行前按配方建立登录态（Playwright storageState）注入 `page`，登录一次按需重登。

## 变量值从哪来（${ENV:VAR} 的解析来源）

按优先级：**本次运行参数显式传入 > 平台环境值**（环境在平台侧按项目配置，值集引用；secret 值加密存储、不回显）> worker 环境变量。变量清单在 `tern.yaml` 的 `env.variables` 声明（凭据类标 `secret: true`）；环境缺值时创建运行即报错并列出缺失变量名。缺 `BASE_URL` 且 auth 用相对地址时，worker 端报 AuthError。

## 形态判别

- **有顶层 `mode` = 单配方**（推荐）：整个项目一套登录方法，用 `accounts` 表区分身份。
- **没有 `mode`、下面全是名字 = 多配方**（进阶）：登录方法本身不同时才用。

## 单配方：mode: api（接口登录）

```yaml
auth:
  mode: api
  method: GET # 默认 POST；GET 时 body 被忽略
  url: /api/auth/mock-login # 相对路径拼接运行参数 BASE_URL
  query: # query string；值可含占位符
    clientId: ${account.clientId}
  headers: {} # 可选
  body: {} # 可选，JSON body（GET 时忽略）
  success:
    cookie: session_token # 响应必须种出该 cookie
    json: success # JSON 路径必须为真值（统一响应信封场景必配）
  validate: /api/auth/findUserLoginInfo # 可选：会话校验 URL；失效按原配方重登
  reuse: worker # 默认 worker：本 run 内同「配方+账号+环境」只登一次；never = 每条用例都登
  accounts: # 可选；缺省只有一个 default
    default:
      clientId: ${ENV:CLIENT_ID}
    admin:
      clientId: ${ENV:ADMIN_CLIENT_ID}
```

要点：

- 按**重定向链收集 Set-Cookie** 写入 storageState；cookie domain 用请求 URL 的 hostname。
- **不能只看 HTTP 状态码**：部分后端业务失败仍返回 HTTP 200 + `{success:false}`，所以必须配 `success.json`（或 `success.cookie`）。
- `success` 都不写时：HTTP 2xx **且**至少种出一个 cookie；若 body 是对象且含 `success` 字段则必须为 true。

## 单配方：mode: form（表单登录）

无头浏览器真实走登录页，失败自动留截图 + trace：

```yaml
auth:
  mode: form
  loginUrl: /login # 登录页地址（相对 BASE_URL）
  user: '#username' # 用户名输入框选择器
  pass: '#password' # 密码输入框选择器
  submit: '#login-btn' # 提交按钮选择器
  username: ${ENV:USER} # 凭据占位符
  password: ${ENV:PASS}
  success:
    url: '**/home' # 成功后 URL glob，和/或
    locator: '[data-testid=user-menu]' # 成功后可见元素
```

## 单配方：mode: storage（直写，已有长期 token）

```yaml
auth:
  mode: storage
  cookie:
    name: session_token
    value: ${ENV:TOKEN} # domain/origin 缺省从 BASE_URL 推导
  # 也支持 cookies: [...（Playwright Cookie 数组）] 与 localStorage:
  #   origin: https://…
  #   entries: { key: value, … }
```

## 多配方（登录方法本身不同，少用）

```yaml
auth:
  default:
    mode: api
    method: GET
    url: /api/auth/mock-login
    query: { clientId: ${ENV:CLIENT_ID} }
    success: { cookie: session_token }
  sso-admin:
    mode: form
    loginUrl: /login
    user: '#username'
    pass: '#password'
    submit: '#login-btn'
    username: ${ENV:ADMIN_USER}
    password: ${ENV:ADMIN_PASS}
```

## 占位符与引用规则

| 写法               | 来源                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `${ENV:VAR}`       | 本次运行参数 ∪ worker 环境；缺变量 → 该次执行 `AuthError`，信息含变量名 |
| `${account.field}` | 当前选中账号的账号表字段（账号字段本身仍可用 `${ENV:}`）                |

用例 frontmatter `auth:` 引用：

| 写法          | 含义                                            |
| ------------- | ----------------------------------------------- |
| （不写）      | 默认登录：单配方 + `default` 账号               |
| `auth: none`  | 不带登录态（登录页/未登录负向用例）             |
| `auth: admin` | 单配方 = `accounts` 里的账号名；多配方 = 配方名 |

**禁止**在用例里写登录 URL、选择器、密码、token。

## 运行期覆盖（不改仓库文件）

| 场景               | 做法                                                        |
| ------------------ | ----------------------------------------------------------- |
| 换环境 / 换设备    | 运行参数改 `BASE_URL`、`CLIENT_ID`                          |
| 直写 token 过期    | 运行参数带新 `TOKEN`                                        |
| 本轮全部用管理员   | 运行参数 `AUTH_ACCOUNT=admin`（只覆盖**没写 auth** 的用例） |
| 某条必须用审计账号 | 该用例 frontmatter `auth: auditor`                          |
| 跑到一半会话失效   | 配了 `validate` 时自动校验，失效按原配方重登一次            |

约定参数：`BASE_URL`（被测系统地址；相对登录地址与 cookie domain 推导都用它）、`AUTH_ACCOUNT`（运行级账号覆盖）。

## 生效时机

- 改登录 URL / 账号表 → push 进仓库并让平台拉取，**下一轮运行**生效（配方在创建 run 时从当前 clone 快照）。
- 只改这次的 clientId / token → **只改运行参数**，立刻生效。
