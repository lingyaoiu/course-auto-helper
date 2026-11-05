# 安装说明

## 0. 准备

| 需要 | 说明 |
|---|---|
| 浏览器 | Chrome / Edge（推荐） |
| 脚本管理器 | [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey / ScriptCat 任选其一 |
| Node.js | 18 或更新（推荐 20/22），用于本地 AI 服务 |
| AI API | DeepSeek 或任意 OpenAI 兼容接口（有 key 才能自动答题） |

## 1. 安装 Node.js

到 https://nodejs.org/ 下载 LTS 版本安装，装完在命令行执行 `node -v` 能看到版本号即可。

## 2. 配置并启动本地 AI 服务

```bash
cd server
copy ai-tiku.config.example.json ai-tiku.config.json    # Windows
# cp ai-tiku.config.example.json ai-tiku.config.json    # macOS/Linux
```

用记事本打开 `ai-tiku.config.json`，把 `apiKey` 改成你自己的 Key：

```json
"apiKey": "sk-你的key"
```

然后启动：

```bash
node ai-tiku-server.js
# 或 Windows 双击 start-ai-tiku.cmd
```

看到 `listening on 127.0.0.1:8765` 表示成功。
浏览器访问 <http://127.0.0.1:8765/health> 应返回 `{"ok":true,...}`。

> 服务只监听本机（127.0.0.1），不会对外网开放。

## 3. 安装用户脚本

打开脚本管理器 → 新建脚本 → 把 `scripts/` 下想用的文件内容整体粘贴进去 → 保存（Ctrl+S）。

每个脚本头部的 `@match` 写了支持的站点，装完刷新对应页面即可。

| 脚本 | 用在哪 |
|---|---|
| `course-helper.user.js` | 视频学习页（挂机刷学时） |
| `course-exam.user.js` | 作业/考试列表页 |
| `course-grade-feedback.user.js` | 作业/考试「结果·查看答案」页 |
| `course-mastery.user.js` | 掌握度页（智慧树） |
| `course-discuss.user.js` | 课程问答/讨论区（智慧树） |
| `course-login.user.js` | 智慧树登录页 |

## 4. 配合 OCS 桌面版（可选）

如果你在用 [OCS 网课助手](https://docs.ocsjs.com/) 桌面版：

1. 先启动本地 AI 服务（否则 OCS 会卡在「正在安装用户脚本」）；
2. OCS → 脚本列表 → 添加脚本（网络脚本），地址填：
   `http://127.0.0.1:8765/scripts/course-xxx.user.js`
   （本地服务已内置脚本分发，脚本会随仓库更新）

## 5. 开始使用

打开对应页面，右下角会出现深色面板：

- 视频页：点「开始」挂机；
- 作业列表：点「开始」自动进入下一份；
- 掌握度页：点「开始」自动刷 <100% 的知识点；
- 讨论区：点「开始」自动回答。

## 常见问题

见 [faq.md](faq.md)。
