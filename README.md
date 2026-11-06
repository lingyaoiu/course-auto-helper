> 网课助手｜智慧树自动刷课 · AI 自动答题 · 自动交卷 · 掌握度刷满 · 讨论区自动回复 · 开源免费
>
> 📖 新手请先看：[保姆级安装教程](./保姆级教程.md)

# 网课助手工具包（智慧树 / 学习通等）

一套本地运行的网课辅助工具：自动挂机学习、作业自动流程、讨论区自动参与、成绩回填、掌握度练习、本地 AI 搜题。

> ⚠️ **先看[免责声明](DISCLAIMER.md)**：本工具仅供个人学习研究，使用产生的后果由使用者自行承担。

## 这堆东西是干什么的

| 脚本 | 作用 |
|---|---|
| `course-helper.user.js` | 视频挂机：自动播放、自动跳过已学、进入下一节，学时按真实播放时长累计 |
| `course-exam.user.js` | 作业流程：列表页自动进入下一份作业，等 OCS 答完后自动提交，再回列表继续 |
| `course-discuss.user.js` | 讨论区：自动回答课程问答区的问题、可连发新话题 |
| `course-grade-feedback.user.js` | 成绩回填：在「结果/解析页」提取题目与参考答案，回填到本地题库，让 AI 越用越准 |
| `course-mastery.user.js` | 掌握度练习：自动重做掌握度 < 100% 的知识点，答完自动提交、回填参考答案，直到刷满 |
| `course-login.user.js` | 登录助手：自动填学校、勾选协议、点登录（验证码需手动） |

所有脚本都通过本地 AI 服务答题，**AI 服务只监听 127.0.0.1，不会把数据传到别处**（除了你自己配置的 AI API）。

## 快速开始

### 1. 启动本地 AI 服务（必须先启动）

需要 Node.js 18+（推荐 20/22）。

```bash
# 把 ai-tiku.config.example.json 复制一份改名为 ai-tiku.config.json
# 编辑 ai-tiku.config.json，填入你的 DeepSeek API Key（baseUrl 可换成任意 OpenAI 兼容接口）
# 编辑 ai-tiku.config.json，填入你的 DeepSeek API Key（baseUrl 可换成任意 OpenAI 兼容接口）
node ai-tiku-server.js
```

看到 `listening on 127.0.0.1:8765` 即成功。浏览器打开 http://127.0.0.1:8765/health 可检查状态。

Windows 下推荐直接双击 `start-ai-tiku.cmd`（会自动复制配置并启动）。

### 2. 安装脚本

用 **Tampermonkey / Violentmonkey / ScriptCat** 新建脚本，把 `course-xxx.user.js` 的内容粘进去保存。

> 也可以配合 **OCS 网课助手桌面版**：在 OCS「脚本列表」里把脚本作为「网络脚本」添加（脚本由本地服务 `http://127.0.0.1:8765/scripts/xxx.user.js` 提供，本仓库的 ai-tiku-server.js 已内置该分发路由）。

### 3. 打开网课平台，面板出现即生效

- 挂机：进入视频页，点面板「开始」；
- 作业流程：进入作业列表页，点「开始」；
- 掌握度：进入掌握度页，点「开始」；
- 讨论区：进入问答页，点「开始」。

## 目录结构

```
course-helper-kit/
├── course-helper.user.js          # 视频挂机
├── course-exam.user.js            # 作业流程（配合 OCS）
├── course-discuss.user.js         # 讨论区自动回答/发帖
├── course-grade-feedback.user.js  # 成绩回填
├── course-mastery.user.js         # 掌握度练习刷满
├── course-login.user.js           # 登录助手
├── ai-tiku-server.js              # 本地 AI 搜题服务（Node.js，零依赖）
├── ai-tiku.config.example.json    # 配置示例（复制为 ai-tiku.config.json 后填 Key）
├── start-ai-tiku.cmd              # Windows 一键启动
├── course-helper-kit.zip          # 全部文件的压缩包
├── INSTALL.md                     # 详细安装说明
├── FAQ.md                         # 常见问题
├── DISCLAIMER.md                  # 免责声明
├── donate-wechat.jpg              # 赞赏码
├── LICENSE
└── README.md
```

## 常见问题

- **面板不出现**：确认脚本已启用、页面地址匹配（每个脚本头部 `@match` 写了支持的站点）；刷新页面。
- **答案不准 / 没有答案**：AI 不是万能的。先确认 `8765/health` 正常、API Key 有余额；做题时多让它跑几次，`成绩回填` 脚本会把正确答案沉淀进题库。
- **OCS 一直转圈「正在安装用户脚本」**：本地服务没启动。先双击启动服务，再开 OCS。
- **验证码/人脸识别**：脚本不处理，需要手动完成。

更多见 [FAQ.md](FAQ.md)。

## 打赏

如果这个工具帮你省了时间，可以请作者喝杯奶茶 ☕ 完全自愿，不影响任何功能。

<img src="donate-wechat.jpg" width="240" alt="微信赞赏码">

## License

[MIT](LICENSE)
