# ============================================
# 项目更新部署到 Vercel 的详细步骤
# ============================================

## 前置条件
- 已安装 Node.js（推荐 v18+）
- 项目已初始化（package.json 存在）

## 第一次部署步骤

### 步骤一：安装 Vercel CLI
```bash
npm install -g vercel
```

### 步骤二：登录 Vercel 账号
```bash
vercel login
```
根据提示访问浏览器登录页面完成认证

### 步骤三：创建 vercel.json 配置文件
在项目根目录创建 vercel.json：
```json
{
  "version": 2,
  "builds": [
    {
      "src": "server.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "server.js"
    }
  ]
}
```

### 步骤四：安装项目依赖
```bash
npm install
```

### 步骤五：首次部署到生产环境
```bash
vercel --prod
```
根据提示回答问题：
- "Which project?" → 选择 "Create a new project"
- "Name?" → 输入项目名称（如 xrzl）
- "Customize advanced settings?" → 输入 N（使用默认配置）

### 步骤六：验证部署结果
1. 部署完成后会显示生产环境地址和别名（如 https://xrzl.vercel.app）
2. 访问该地址验证项目是否正常运行

## 更新部署步骤

### 步骤一：检查项目状态
确认代码已保存，运行以下命令查看项目结构：
```bash
ls -la
```

### 步骤二：安装依赖（如果有新增依赖）
```bash
npm install
```

### 步骤三：本地测试（可选但推荐）
启动本地服务器验证修改是否正常：
```bash
npm start
```
访问 http://localhost:3000 测试功能

### 步骤四：部署到生产环境
```bash
vercel --prod
```

### 步骤五：验证部署结果
1. 部署完成后会显示生产环境地址
2. 访问 https://xrzl.vercel.app 验证更新是否生效
3. 检查页面功能是否正常

## 常用命令

- 查看部署日志:
  ```bash
  vercel inspect xrzl.vercel.app --logs
  ```

- 重新部署（不修改代码）:
  ```bash
  vercel redeploy xrzl.vercel.app
  ```

- 预览部署（测试环境）:
  ```bash
  vercel
  ```

- 查看项目配置:
  ```bash
  vercel ls
  ```

## 注意事项

1. **冷启动延迟**: Vercel Serverless Functions 在空闲一段时间后会休眠，再次访问时可能有 1-3 秒延迟
2. **执行时间限制**: 单个请求最长执行时间为 10 秒
3. **Socket.io 支持**: Vercel 对 WebSocket 支持有限，可能降级为轮询模式
4. **环境变量**: 如果需要设置环境变量，在 Vercel 控制台项目设置中配置
5. **构建配置**: 项目使用 vercel.json 配置构建规则，确保 server.js 为入口文件

## 故障排除

- 如果部署失败，查看错误日志：
  ```bash
  vercel logs xrzl.vercel.app
  ```

- 如果页面显示旧版本，强制刷新浏览器（Ctrl+Shift+R 或 Cmd+Shift+R）

- 如果 Socket.io 连接问题，检查浏览器控制台的网络请求
