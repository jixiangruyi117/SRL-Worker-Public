# SRL-Worker-Public

可由使用者自行部署的 Cloudflare Worker，为 SillyTavern Resource Library Public 提供设备码中继、加密暂存、GitHub 云备份中继和 Koofr WebDAV 中继。此仓库不托管 SRL 网页，不包含官方账号、登录、资源广场、反馈或官方更新服务。

## 部署

需要 GitHub 账号和自己的 Cloudflare 账号；部署过程在 Cloudflare 上完成，本机不需要安装 Node.js、pnpm 或 Wrangler。

1. 在 GitHub Fork 本仓库。
2. 打开 Cloudflare Dashboard → **Workers & Pages** → **Create application**，在 **Import a repository** 旁选择 **Get started**。
3. 连接 GitHub 并选择刚 Fork 的仓库；若仓库未显示，先授权 Cloudflare GitHub App 访问该仓库。生产分支选择 `main`。
4. 按以下内容配置：
   - Worker 名称：`srl-worker-public`
   - Build command：留空
   - Deploy command：`pnpm exec wrangler deploy --config wrangler.example.jsonc`
   - Preview command：保留默认的 `npx wrangler preview`
   - Enable Preview builds：关闭
   - Protect with Cloudflare Access：关闭
   - Advanced settings：保持默认
5. 选择 **Save and Deploy**。若部署失败，在 Worker 的部署历史中打开本次构建日志。

Cloudflare 会从仓库安装依赖并运行部署命令。首次部署会创建 `BridgeSession` Durable Object 所需的 SQLite 类。

部署完成后，复制 Cloudflare 显示的 Worker HTTPS 根地址，在 SRL Public 的“设置 → 自部署 Worker”中粘贴并保存。地址保存在当前浏览器或 APK 的本机设置中。

以后在 GitHub Fork 页面点击 **Sync fork → Update branch**，Cloudflare 监听到 `main` 更新后会自动重新部署。

## 提供的接口

- `/api/bridge/*`：酒馆设备码中继与加密暂存。中继内容由端到端加密或应用层令牌保护；Worker 只暂存加密分块及必要的短期会话状态。
- `/api/cloud/health`：Koofr 代理健康检查。
- `/api/cloud/proxy/koofr?url=...`：仅允许转发到 `https://app.koofr.net/dav/Koofr/` 下的 WebDAV 地址。请求凭据由用户自己的浏览器发送至其 Worker，再转发给 Koofr；Worker 不持久化这些凭据。
- `/api/cloud/proxy/github?url=...`：可选的 GitHub 备份中继，仅允许 SRL 所需的仓库、Release 和附件 API 路径及对应 HTTP 方法。浏览器会把使用者自己的 GitHub Token 和备份对象经其自部署 Worker 转发至 GitHub；Worker 不保存请求、凭据或备份数据。未配置自部署 Worker 时，Public 网页仍直连 GitHub，不会切换到维护者的 Worker。

浏览器调用使用不带 Cookie 的 CORS 请求。CORS 只允许常规网页、Capacitor、Ionic 与 Tauri 来源，不构成用户身份验证；请只在自己的 Cloudflare 账号部署，并妥善保管 Koofr 凭据与 GitHub Token。

## 本地检查（维护者可选）

以下命令仅供维护者在本机开发和验证，不是部署步骤；需要 Node.js 22 或更新版本及 pnpm 11。

```powershell
pnpm test
pnpm exec wrangler deploy --dry-run --config wrangler.example.jsonc
```

源码许可与上游来源见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

## GitHub 备份中继

GitHub 中继使用固定目标主机与路径白名单，只接受备份所需的 API 操作；单次请求体上限为 64 MiB。请求中的 GitHub Token 和备份对象仅转发给 GitHub，不写入 Worker 存储。仓库管理员仍应仅在自己的 Cloudflare 账号部署，并将 Worker 地址保存在 Public 的本机设置中。

## 1.0.2 更新

新增可选 GitHub 云备份中继，支持仓库连接检查、备份上传、列表、下载和清理。私有 Release 附件下载只跟随 GitHub 的签名附件地址，不向下载服务器转发仓库 Token；无效跳转或附件服务器连接失败返回明确错误，并标记实际上游阶段。使用新版 Public 网页并配置自部署 Worker 时，需要同步更新本 Worker；APK 原生 GitHub 直连不依赖此接口。

## 1.0.1 更新

收到已认证接收方的分块确认时，先释放该方中继收件队列，再转发确认；与新版互传客户端保持一致，不清除另一端队列。暂存格式、过期时间和 Koofr 接口保持原行为。
