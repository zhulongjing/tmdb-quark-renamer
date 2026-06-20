# TMDB 夸克网盘影视重命名（Chrome 扩展）

一个基于 TMDB API + 本地智能解析的 Chrome 浏览器扩展，用于自动识别并重命名夸克网盘（pan.quark.cn）中的影视文件。

## ✨ 功能特性

- **TMDB 智能匹配**：根据文件名自动解析中英文标题、年份、季集信息，并通过 TMDB API 搜索匹配最佳结果
- **本地 AI 解析引擎**：内置智能文件名解析器，无需额外服务，可识别：
  - 中英文标题 + 年份
  - 季/集编号（SxxExx、第X季、第X集等）
  - 视频分辨率（1080p、4K 等）和编码格式
  - 自动过滤压制组标签、双语字幕等杂质
- **自动文件夹展开**：自动识别并展开嵌套文件夹中的视频文件
- **智能季/剧文件夹识别**：自动处理"剧文件夹/季文件夹/视频文件"的层级结构
- **批量重命名**：一键批量重命名所有匹配文件，通过夸克网盘官方 API 执行
- **灵活命名格式**：支持自定义命名模板（电影/剧集/简单格式）
- **进度提示**：实时显示自动匹配进度
- **请求捕获工具**：内置调试工具，可捕获查看夸克网盘的重命名请求

## 📁 项目结构

```
tmdb-quark-renamer/
├── manifest.json      # 扩展清单文件（MV3）
├── background.js      # 后台服务：TMDB 搜索、API 调用、重命名执行
├── content.js         # 内容脚本：页面交互、文件列表获取、夸克 API 代理
├── popup.html         # 弹窗 UI
├── popup.js           # 弹窗逻辑：文件列表渲染、智能匹配、手动修正
├── styles.css         # 样式表
├── icons/             # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## 🚀 安装步骤

### 方式一：开发者模式加载（推荐）

1. 克隆或下载本仓库到本地
2. 打开 Chrome 浏览器，访问 `chrome://extensions/`
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择本项目所在文件夹
6. 扩展已安装完成 ✅

### 方式二：打包为 crx

```bash
# 在 Chrome 扩展管理页点击"打包扩展程序"，选择项目文件夹
```

## ⚙️ 使用方法

### 1. 获取 TMDB API Key

1. 访问 [TMDB 官网](https://www.themoviedb.org/) 注册账号
2. 进入 [API 设置页](https://www.themoviedb.org/settings/api)，申请 API Key（选择 Developer）
3. 复制生成的 API Key（v3 版本）

### 2. 配置扩展

1. 在浏览器中访问 [夸克网盘](https://pan.quark.cn/) 并登录
2. 点击浏览器工具栏中的扩展图标，打开弹窗
3. 在「TMDB API Key」输入框中粘贴你的 API Key
4. 点击「保存」

### 3. 开始使用

1. 在夸克网盘中，勾选需要重命名的影视文件（可以是视频文件或剧/季文件夹）
2. 点击扩展图标打开弹窗
3. 扩展会自动：
   - 获取选中文件列表
   - 展开嵌套文件夹
   - 解析文件名
   - 通过 TMDB 搜索匹配
   - 生成标准格式的新文件名
4. 在弹窗中查看预览，可以手动修改或重新搜索
5. 点击「批量重命名」按钮完成操作

## 🎯 命名规则示例

| 类型 | 原始名称 | 重命名后 |
|------|----------|----------|
| 电影 | 阿凡达.2009.1080p.BluRay.x264.mp4 | 阿凡达 2009 1080P.mp4 |
| 单集 | breaking.bad.s01e01.1080p.mkv | 绝命毒师 2008 1080P S01E01.mkv |
| 季文件夹 | Breaking.Bad.S01.1080p | 绝命毒师 2008 Season 01 |
| 剧文件夹 | Breaking Bad 全集 | 绝命毒师 2008 |

## 🔧 技术栈

- **Manifest V3**：Chrome 扩展最新标准
- **原生 JavaScript**：无外部依赖，无需构建
- **TMDB API**：https://api.themoviedb.org/3/
- **夸克网盘 API**：`drive-pc.quark.cn` 接口（通过页面 Cookie 认证）

### 核心模块说明

#### background.js
- `captureRename()`：在目标页面注入请求拦截器，用于调试
- `executeRename()`：调用夸克网盘重命名 API，支持重试、多种来源
- `doRename()`：实际重命名执行逻辑，动态延迟避免限流

#### content.js
- `getCheckedFilesFromDOM()`：从页面 DOM 读取勾选的文件
- `getAllFilesInCurrentFolder()`：通过夸克 API 获取当前文件夹所有文件
- `expandFolders()`：递归展开子文件夹，识别季文件夹
- `batchRename()`：批量重命名主入口，优先通过 iframe 通信回传结果

#### popup.js
- `parseFilename()`：核心文件名解析器（标题/年份/季集/分辨率等）
- `smartSearchTMDB()`：TMDB 智能搜索与评分匹配算法
- `scoreTMDBResult()`：候选结果综合评分（标题相似度、年份、类型等）
- `generateFileName()`：标准文件名生成器
- `analyzeFolderStructure()`：文件夹结构分析（剧/季/文件层级推断）
- `syncFolderFiles()`：同文件夹文件的批量同步匹配
- `autoSearchAllFiles()`：全自动搜索与匹配流程

## 📝 注意事项

1. **API Key 安全**：扩展使用 `chrome.storage.sync` 保存 API Key，仅存储在本地浏览器，不会上传
2. **Cookie 认证**：重命名操作依赖当前浏览器中夸克网盘的登录 Cookie，请保持登录状态
3. **文件大小限制**：扩展弹窗一次最多显示约 500 个文件，建议分批操作
4. **API 限流**：为避免触发夸克网盘限流，扩展已内置动态延迟策略
5. **网络要求**：访问 TMDB API 需可访问国外网络（如无法访问可能导致匹配失败）

## 🐛 常见问题

**Q: 点击扩展图标后提示"无法连接夸克页面"**
A: 请确保当前标签页打开的是 `pan.quark.cn` 且已登录，然后刷新页面再重试

**Q: 搜索结果为空或匹配不正确**
A: 1. 检查 TMDB API Key 是否正确；2. 检查是否可正常访问 TMDB；3. 可点击文件下方的"搜索"按钮手动输入关键词

**Q: 重命名失败提示"3种origin均失败"**
A: 可能是夸克网盘接口变更或权限问题。可使用弹窗底部的「📡 捕获请求」工具，在夸克页面手动重命名一次后查看捕获的请求参数

**Q: 文件夹中的视频文件没有被识别**
A: 扩展仅识别常见视频扩展名（mp4/mkv/avi/mov/wmv/flv/f4v/m4v/ts/m2ts/vob/mpg/mpeg/rm/rmvb/3gp/3g2/asf/divx/xvid）。如果是其他扩展名，建议先将文件改为视频扩展名后再操作

## 📄 License

MIT License

## 免责声明

本扩展仅供个人学习与数据整理使用。请遵守夸克网盘用户协议及相关法律法规，不得用于任何商业用途或侵害他人权益的行为。使用本扩展造成的一切后果由使用者自行承担。

---

**Enjoy organizing your media library! 🎬**
