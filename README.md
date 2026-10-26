# 笺谈 · MarginTalk

在书页边缘，把批注变成对话。Bun、Svelte、Framework7 实现的多用户 Markdown 阅读与对话式批注服务，保留 Kami 风格的纸感界面。

## 能做什么

- 使用 **Login with Amazon** 登录，服务端建立独立账户和持久会话。
- 选择本地 Markdown 文件后自动上传到当前账户；正文和批注保存在服务端 SQLite 中。
- 在云文件列表中打开、查看和删除文档；其他账户不能读取或操作这些文档。
- 长按正文放置曲别针，批注自动保存。已有用户 / AI 对话随文档加载和同步。
- AI 的 URL、密钥、模型和思考设置只由服务器配置。浏览器不配置、不持有 AI 密钥，也不能指定转发目标。
- 服务端从已存储的文档和批注构造请求，流式返回思考和回复，并保存回复。请求失败时已保存的用户批注不会消失。

## 安装与本地运行

```bash
bun install --frozen-lockfile
cp margintalk.config.example.toml margintalk.config.toml
# 编辑 margintalk.config.toml
bun run dev
```

`bun run dev` 同时启动 Bun API（默认 3000）和 Vite（默认 5173）。开发页面访问 `http://127.0.0.1:5173`，开发配置的 `server.publicURL` 必须与这个页面的 origin 一致。端口可通过配置文件及 Vite 参数调整；端口被占用时启动失败，不会自动换端口而破坏 OAuth 回调及同源校验。升级后请先停止旧 Vite 进程，再重启开发命令。

未填写 Amazon 或 AI 配置时，页面仍可展示，但相应功能明确显示未配置；**没有开发免登录、伪造用户或匿名上传接口**。
开发服务也禁止通过 HTTP、`?raw` 和文件路径读取服务器配置、数据库及其 WAL/SHM 文件；
`bun run dev` 会将实际配置与数据库路径加入 Vite 禁止列表，包括自定义文件名，而不只依赖扩展名。

### 服务端配置

默认读取当前目录的 `margintalk.config.toml`，也可设置：

```bash
MARGINTALK_CONFIG=/absolute/private/margintalk.config.toml bun run start
```

配置文件示例：

```toml
[server]
host = "127.0.0.1"
port = 3000
publicURL = "http://127.0.0.1:5173"
databasePath = "./data/margintalk.sqlite"

[amazon]
clientId = "填写 Login with Amazon Client ID"
clientSecret = "填写 Login with Amazon Client Secret"

[ai]
baseURL = "https://api.openai.com/v1"
apiKey = "填写服务器 AI 密钥"
model = "gpt-4o-mini"
reasoningEffort = ""
```

- `databasePath` 相对**配置文件目录**解析。父目录自动创建；数据库、WAL 和 SHM 文件不能放在公开静态目录中。
- `publicURL` 必须是纯 origin，不含路径、用户名、查询或片段。非 loopback 部署必须 HTTPS；AI 远端 URL 同样要求 HTTPS。
- `reasoningEffort` 是模型支持的字符串，如 `max`、`high`、`true`；空串不注入思考参数。配置值对所有用户生效。
- 默认配置文件缺失时按未配置运行；显式指定的配置路径缺失或无效会使启动失败。
- `margintalk.config.toml` 和 `data/` 已加入忽略规则。不要提交真实密钥，也不要把服务器配置放进 Vite 的 `VITE_*` 变量。

## Amazon OAuth 配置

1. 在 [Login with Amazon Console](https://developer.amazon.com/loginwithamazon/console/site/lwa/overview.html) 创建 Security Profile，获取 Client ID 和 Client Secret。
2. 设置网站的允许来源和 **Allowed Return URL**：
   `https://你的域名/auth/amazon/callback`。
3. 将 `server.publicURL` 设置为 `https://你的域名`，将凭据写入服务器配置后重启。
4. 使用 HTTPS 访问网站并点击 Amazon 登录。

实现使用服务端 Authorization Code Grant、PKCE S256 和一次性、浏览器绑定的 OAuth state；令牌交换及用户资料请求均在服务端进行。账户身份依据 Amazon `user_id`，不依据客户端提交的邮箱。OAuth access token 不写入数据库或浏览器。

Amazon 官方文档要求真实授权回调使用 HTTPS；本地 HTTP 开发地址用于页面开发及隔离协议测试，**不代表 Amazon 会接受未注册的 HTTP 回调**。真实登录需要你自己的已注册应用和 HTTPS 域名。参见 [Authorization Code Grant](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html)。

## 生产部署

```bash
bun run build
MARGINTALK_CONFIG=/absolute/private/margintalk.config.toml bun run start
```

生产 Bun 进程在同一 origin 下提供构建后的 `dist/`、认证和 API；不需要 Vite，也不再提供旧的通用 AI 转发地址。`bun run preview` 同样运行完整 Bun 服务而非纯静态预览。

- 使用 HTTPS 反向代理，将请求转至 Bun 监听端口。代理不要修改浏览器的 `Origin`，否则写请求会被拒绝。
- 为 SSE 关闭响应缓冲，读取超时应超过 AI 请求的 3 分钟上限。例如在现有 TLS server 的 location 中：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 240s;
    client_max_body_size 4m;
}
```

- 为 `databasePath` 所在目录挂载持久卷，并限制文件访问权限。重启后账户、会话、正文和批注保留；删除容器的临时文件系统不是可靠存储。
- SQLite 使用 WAL。备份应使用 SQLite 在线备份或停服后复制数据库及相关文件，不要在写入中只复制主文件。
- 仅将一个服务实例绑定到该 SQLite 持久卷；如部署多个实例，应先设计共享数据库及分布式部署方式，不要用独立数据库副本冒充同步。
- 在反向代理按部署需要限制认证和 AI 请求速率，并监控 AI 服务预算。

## API 与同步边界

- `GET /api/session` 返回账户、CSRF token 及服务是否已配置，不返回 AI/OAuth 凭据。
- `GET /auth/amazon`、`GET /auth/amazon/callback` 完成登录；`POST /api/logout` 撤销会话。
- `GET/POST /api/documents` 列表 / 上传；`GET/PUT/DELETE /api/documents/:id` 读取、同步批注 / 删除。
- `POST /api/documents/:id/reply` **只接受** `{ revision, clipId, content }`。不接受客户端的 URL、密钥、模型、prompt 或 messages。服务端读取用户自己的存储记录并调用配置好的 AI。
- 写请求需要当前会话、同源 `Origin` 及 `X-CSRF-Token`。会话 cookie 为 HttpOnly、SameSite=Lax，HTTPS 下启用 Secure。
- 每份文档有递增 `revision`。过期版本及生成中的冲突操作返回 409，不静默覆盖其他会话的批注。客户端保留本地修改，要求明确确认加载云端或覆盖云端；网络失败可重试。已删除文档的未同步本地副本可导出或另存新文档，另存会保存完整曲别针快照，包括尚无消息的新曲别针。客户端在安全条件下轮询已打开文档以取得其他会话的更新。
- 上传 JSON 请求上限 4MiB，正文最多 2,000,000 字符，每文档最多 500 个曲别针，每曲别针最多 200 条消息。每文档的批注 JSON（含思考过程）最多 3MiB，为同步请求留出余量；AI 生成也不能突破此持久化上限。超限会返回明确错误，不会静默截断，已保存的用户提问保留。
- 文档及 AI HTML 均视为不可信内容；显示前清洗。AI 生成后的回复先清洗再持久化。

## 阅读区交互

桌面正文无固定最大宽度，侧栏打开 / 关闭时自动重排。640px 及以下手机显示近全屏批注层，左侧保留 48px 毛玻璃退出区。正文禁止拖选；普通按钮至少 48px，曲别针至少 44px。手机发送按钮独占整行，输入框使用 16px 字号。

批注按原位的 `aside` / `blockquote` / `footer` 结构加入原始 Markdown，包含历史对话和目标 AI 回复占位注释。完整 Prompt 在服务端统一 HTML 转义，仍使用简短提示词、单次请求、无工具的方式调用 AI。导出的带批注 Markdown 可重新导入账户。

## 验证

```bash
bun run test:unit
bun run check
bun run test
```

单测和集成验证覆盖 SQLite 持久化、多账户隔离、CSRF、OAuth state/PKCE、版本冲突、生成锁、进程被杀后的恢复、服务端窄 AI 接口、错误后的批注保留以及生产静态路径隔离。`bun run test` 会先构建 `dist/`，再对真正的 Bun 生产静态/API 服务运行浏览器套件；不是绕过安全头的 Vite 预览。套件使用独立 SQLite 和 OAuth/AI 协议测试服务；测试身份只在测试服务中存在，不会注册到生产应用。

这些本地测试不能替代你自己的 Amazon 应用在真实 HTTPS 回调域名上的登录验证，也不能替代真实 AI 端点的兼容性验证。

TypeScript 工具链按当前 svelte-check 要求同时安装 TypeScript 6 和 TypeScript 7 原生编译器别名，检查使用 `--tsgo`。
