# VSCode Dev Container 配置

这个目录包含 VSCode Dev Containers 的配置文件，用于提供一致的开发环境。

## 使用方法

### 前置要求

1. 安装 [Docker Desktop](https://www.docker.com/products/docker-desktop)
2. 安装 [VSCode](https://code.visualstudio.com/)
3. 安装 VSCode 扩展：[Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

### 启动开发容器

1. 在 VSCode 中打开项目
2. 按 `F1` 或 `Cmd+Shift+P` 打开命令面板
3. 选择 `Dev Containers: Reopen in Container`
4. 等待容器构建和初始化完成

或者点击 VSCode 左下角的绿色按钮，选择 "Reopen in Container"。

### 功能特性

- **Node.js 24**: 预装 Node.js 24 LTS 版本
- **Chromium**: 用于 Puppeteer/Playwright 自动化测试
- **自动安装依赖**: 容器创建后自动运行 `npm install`
- **端口转发**: 自动转发端口 3000（API）和 5173（Vite）
- **VSCode 扩展**: 预装 ESLint、Prettier、Vue 等开发扩展
- **Git 集成**: 内置 Git 和 GitHub CLI

### 开发命令

容器启动后，可以在终端中运行：

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 运行测试
npm test

# 构建项目
npm run build
```

### 文件说明

- `devcontainer.json`: Dev Container 主配置文件
- `Dockerfile`: 开发环境的 Docker 镜像定义
- `docker-compose.yml`: Docker Compose 配置（可选）
- `README.md`: 本文档

## 自定义配置

如需自定义开发环境，可以编辑 `devcontainer.json` 文件：

- **添加 VSCode 扩展**: 修改 `extensions` 数组
- **修改端口**: 更新 `forwardPorts` 数组
- **添加 features**: 在 `features` 对象中添加所需功能
- **运行脚本**: 修改 `postCreateCommand` 或 `postStartCommand`

## 故障排除

### 容器构建失败

```bash
# 清理 Docker 缓存
docker system prune -a

# 重新构建容器
```

### 依赖安装问题

```bash
# 在容器内手动安装
npm install --verbose
```

### 端口冲突

如果端口被占用，可以在 `devcontainer.json` 中修改 `forwardPorts` 配置。
