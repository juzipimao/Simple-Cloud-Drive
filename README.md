## Simple Cloud Drive (Debian Ready)

一个开箱即用的简易云盘，登录后可进行文件管理、上传下载、Markdown/文本在线预览与编辑。提供 Docker 与本地部署两种方式。

### 功能
- 游客：不能浏览或预览文件；仅持有有效临时链接时可下载对应的单个文件
- 管理员：登录后可浏览、预览、下载、上传、重命名、删除、创建文件夹、在线编辑文本/Markdown
- Markdown 预览（客户端渲染），文本在线编辑
- 单用户管理员（用环境变量配置）
- 受限根目录，防止越权访问
- 每个文件可生成无需登录的临时下载链接，固定 1 小时有效

### 目录结构
```
server/           Express 服务端
public/           前端静态页面（文件浏览、预览、编辑）
storage/          默认存储根目录（可用卷挂载覆盖）
```

### 快速开始（Docker 推荐）
1) 配置环境变量
#### 环境变量（.env 文件）
创建并编辑 `.env` 文件来配置应用，各参数说明：

| 变量名 | 用途 | 默认值 | 说明 |
|--------|------|--------|------|
| `PORT` | 应用服务端口 | `8089` | 修改后需重启容器 |
| `JWT_SECRET` | JWT 令牌加密密钥 | `change_me_to_a_long_random_string` | **必须修改**，建议48位随机字符 |
| `STORAGE_ROOT` | 文件存储根目录 | `storage` | Docker环境通常为 `/storage` |
| `ADMIN_USERNAME` | 管理员用户名 | `admin` | 用于管理员登录 |
| `ADMIN_PASSWORD` | 管理员密码 | `admin123` | **生产环境必须修改** |
| `NODE_ENV` | 运行环境 | 无 | 设为 `production` 启用HTTPS安全策略 |
| `HTTPS` | HTTPS模式开关 | 无 | 设为 `true` 启用HTTPS安全策略 |

2) 启动（需要 Docker 与 docker-compose）
```bash
docker compose up -d --build
```

3) 访问
- 浏览器打开: http://<你的服务器IP或域名>:8089/start-index
- 管理员登录: 使用 `.env` 中的 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD`

4) 数据卷
- 将宿主机目录挂载到容器内 `/storage`，用于持久化文件（已在 docker-compose.yml 配置为 `./storage:/storage`）

### 本地部署（Debian）
1) 准备 Node.js 18+（示例使用 Node 20）
```bash
sudo apt-get update
sudo apt-get install -y curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

2) 安装依赖并启动
```bash
# 配置环境变量（参考 env.example）
cp env.example .env
# 重要：编辑 .env 文件，修改密码和密钥
nano .env

npm install
npm run start
```

3) 访问
- 浏览器打开: http://<你的服务器IP或域名>:8089/start-index

### 反向代理（Nginx 示例）
```
server {
    listen 80;
    server_name your.domain.com;

    location / {
        proxy_pass http://127.0.0.1:8089;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 一键部署
当前仓库不包含一键脚本。请参考上面的 “快速开始（Docker 推荐）/本地部署（Debian）/反向代理（Nginx 示例）” 步骤进行部署。

### 配置说明

#### 安全策略配置
应用根据环境自动调整安全策略：
- **HTTP环境**：禁用严格的跨域安全策略，适合开发和HTTP访问
- **HTTPS环境**：启用完整安全防护（COOP、CSP等），适合生产环境

触发HTTPS安全模式的条件：
- 设置 `NODE_ENV=production`
- 或设置 `HTTPS=true`

### 权限说明
- 未登录即视为游客：访问云盘先跳转至 `/start-index/login`，不能查看文件列表、预览或使用普通下载接口；有效临时下载链接是唯一的文件访问例外
- 登录成功签发 httpOnly Cookie（JWT）：获得管理员权限
- 服务端统一校验所有文件接口（含 `/api` 兼容路径）及文件管理页，不依赖前端控制

### 临时下载链接

1. 管理员登录后，点击文件操作栏的 **临时链接**。
2. 弹窗显示完整下载地址与过期时间，点击 **复制链接** 后发给接收者；HTTP 环境不支持自动复制时可手动复制。
3. 接收者无需登录即可下载该文件。有效期从生成时算起，固定为 **1 小时**，重复访问不会续期；到期后的 GET/HEAD 请求均返回 404。已开始的下载不会因到期而中断。

安全边界：
- 只有管理员能创建链接，分享令牌不能用于登录、浏览目录或下载其他文件。
- 使用 256 位随机、不含文件路径的令牌，与登录 JWT 完全分离；服务端只保存令牌哈希，拒绝跨来源生成请求。
- 只分享普通文件，拒绝路径穿越和文件/父目录符号链接；Linux 使用固定目录描述符逐层打开，下载不再按路径重新打开文件。
- 链接绑定文件身份与版本。文件修改、替换、重命名、移动、删除后，旧链接不可继续下载该路径的新内容。
- 下载强制作为附件返回，禁止缓存与 Referer 传播；Markdown 预览使用本地 DOMPurify 净化，避免脚本借用管理员会话。
- 链接仅保存在当前服务进程的内存中，**服务重启会使所有旧链接立即失效**；目前适用于单进程部署，多实例部署需先接入共享令牌存储。最多保留 10,000 个未过期链接，达到上限时创建返回 429。
- 链接本身就是下载凭证，接收者可以再次转发；过期不能撤回已经下载到本地的文件。分享时应使用 HTTPS。

### 注意
- 文本/Markdown 在线编辑仅对不超过 2MB 的文本文件开放
- 预览类型基于文件扩展名的白名单

### 开发脚本
```bash
npm run dev   # 开发模式（自动重启）
npm run start # 生产模式
npm test      # 鉴权、临时链接和安全回归测试
```

