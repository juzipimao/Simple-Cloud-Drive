## Simple Cloud Drive (Debian Ready)

一个开箱即用的简易云盘，支持游客/管理员权限，文件管理、上传下载、Markdown/文本在线预览与编辑。提供 Docker 与本地部署两种方式。

### 功能
- 游客：浏览、预览、下载
- 管理员：除游客能力外，还可上传、重命名、删除、创建文件夹、在线编辑文本/Markdown
- Markdown 预览（客户端渲染），文本在线编辑
- 单用户管理员（用环境变量配置）
- 受限根目录，防止越权访问

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
- 浏览器打开: http://<你的服务器IP或域名>:8089
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
- 浏览器打开: http://<你的服务器IP或域名>:8089

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
- 未登录即视为游客：仅能浏览、预览、下载
- 登录成功签发 httpOnly Cookie（JWT）：获得管理员权限
- 服务端对敏感操作进行二次校验，不依赖前端控制

### 注意
- 文本/Markdown 在线编辑仅对不超过 2MB 的文本文件开放
- 预览类型基于文件扩展名的白名单

### 开发脚本
```bash
npm run dev   # 开发模式（自动重启）
npm run start # 生产模式
```


