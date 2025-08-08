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
1) 复制示例环境变量
```bash
cp env.example .env
```

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
cp env.example .env
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

### 环境变量（.env）
- `PORT` 服务端口（默认 8089）
- `JWT_SECRET` JWT 密钥（必填）
- `STORAGE_ROOT` 存储根目录（默认 /storage）
- `ADMIN_USERNAME` 管理员用户名（默认 admin）
- `ADMIN_PASSWORD` 管理员密码（默认 admin123，生产务必修改）

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


