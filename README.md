# 求职岗位抓取

一个面向**车载测试岗位求职**的本地抓取与匹配工具。从 BOSS直聘 / 猎聘抓取全国范围内的相关岗位，自动过滤无关结果、标记外包与猎头，再按个人简历匹配度输出投递优先级表。

核心思路不是「爬得更多」，而是**在真实浏览器里以真人节奏读页面**：直接指挥你已登录的 Safari，只读、低频、不碰验证码。

## 功能特性

### 岗位抓取

- **双渠道支持** — BOSS直聘（无限滚动）+ 猎聘（首屏分页），渠道开关由 `config/keywords.json` 的 `activeSites` 统一控制
- **真实浏览器路线** — 通过 Safari + AppleScript 驱动，使用你本人的登录态，不另起浏览器进程、不改 UA、不注入自动化标记
- **全国范围** — 城市与城市码集中在配置里（BOSS `100010000` / 猎聘 `dqs=410`）
- **关键词矩阵** — 默认 10 个车载测试相关搜索词，可自由增删；每个关键词显式导航并等待 URL 变化，避免读到上一轮结果
- **无限滚动驱动** — Node 侧滚动 → 等待 → 计数，卡片数不再增长即停
- **标签页自管理** — 自己开的标签页自己关，正常退出、异常、Ctrl-C 都会收尾，不碰你已有的标签页

### 反爬与稳定性

- **BOSS 薪资字体解码** — 页面里的薪资数字被替换成 Unicode 私用区码位，用 canvas 现场逐像素比对还原，不写死映射表；解码冲突会自动告警
- **验证码即停** — 命中验证码一律停手交人工，不写自动破解逻辑
- **限流保护** — 关键词间随机延迟、同站连续失败自动停站；原则是「宁可少抓一批，不能把限流撞成封锁」
- **选择器集中配置** — 站点 URL 模板与 DOM 选择器全部在 `config/sites.json`，站点改版只改配置，不改代码

### 过滤与匹配

- **行业门槛** — 必须命中车载/汽车相关词或产业链公司，挡掉船舶、两轮电动车等误判
- **相关度打分** — strong 命中 1 个即保留，medium 需命中 2 个
- **方向排除** — 默认剔除 ADAS / 智驾方向（感知、规控、泊车等），按标题与标签匹配
- **外包/驻场标记** — 按关键词与公司名单打 `isOutsourcing`，猎头代招单独标 `isHeadhunter`
- **历史去重** — `data/jobs.json` 累加保存；`jobId` 优先，缺失时用「站点+公司+标题+地区」；空字段不覆盖历史非空值
- **匹配表输出** — 过滤结果生成 Markdown 候选表，交给人工或 AI 按简历画像打分
- **链接自检** — 逐条回查交付物里的岗位链接，确保点开的就是表里那条

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js v20+（ESM，`type: module`），**无第三方依赖** |
| 浏览器控制 | Safari + AppleScript（复用真实登录态） |
| 数据存储 | JSON 文件（`data/jobs.json`），无数据库 |
| 配置 | `config/*.json` + `config/resume-profile.md` |

## 系统要求

- **macOS**（依赖 Safari 与 AppleScript）
- **Node.js 20+**（开发环境使用 v24）
- **Safari 已登录 BOSS直聘 / 猎聘**（登录态只存在于你本机的 Safari 中，脚本不读取、不导出）

### Safari 前置设置（只需一次）

1. Safari → 设置（⌘,）→ **高级** → 勾选 **显示网页开发者功能**
2. 切到 **开发** 标签页 → 勾选 **允许来自 Apple Events 的 JavaScript**

> ⚠️ 这个开关允许持有「自动化」权限的程序向页面注入 JavaScript。抓取完成后建议关掉。

## 安装

```bash
git clone <repository-url>
cd job-crawler
```

无需 `npm install` —— 项目零第三方依赖。

## 快速开始

### 1. 配置简历画像

```bash
cp config/resume-profile.example.md config/resume-profile.md
```

按自己的真实情况填写。该文件已被 `.gitignore` 忽略，不会进入仓库。

### 2. 检查 Safari 权限

```bash
node --input-type=module -e "const {listTabs}=await import('./scripts/lib/safari.mjs'); console.log((await listTabs()).length)"
```

能打印标签页数量即表示 AppleScript 链路正常（零网络请求）。

### 3. 小批量试跑

```bash
# 只抓一个词，不落盘
node scripts/safari-crawl.mjs --site boss --keyword 车载测试 --dry

# 每个站抓两个关键词，验证结构和字段
node scripts/safari-crawl.mjs --site boss --max-keywords 2 --dry
```

### 4. 正式抓取

```bash
# 按 activeSites 跑两站（10 个关键词，约 8–15 分钟）
node scripts/safari-crawl.mjs

# 只跑一个站
node scripts/safari-crawl.mjs --site boss
```

启动时会打印本次开始时间（UTC），记下来给下一步用。

### 5. 生成候选表

```bash
node scripts/report.mjs --crawled-after 2026-10-19T01:00:00Z
```

输出位于 `output/候选岗位-YYYYMMDD-HHMMSS.md`。`--crawled-after` 建议必带：`jobs.json` 只增不删，不带会把上一轮已下架的岗位混进来。

### 6. 检查链接

```bash
node scripts/check-links.mjs output/候选岗位-YYYYMMDD-HHMMSS.md
```

全部命中退出码为 0，有未命中为 1。

## 常用命令

```bash
# 抓取
node scripts/safari-crawl.mjs --site boss
node scripts/safari-crawl.mjs --site boss,liepin
node scripts/safari-crawl.mjs --site boss --max-keywords 2 --dry
node scripts/safari-crawl.mjs --site boss --keyword 车载测试
node scripts/safari-crawl.mjs --help

# 站点改版时探页面结构
node scripts/probe-safari.mjs boss 车载测试
node scripts/probe-safari.mjs boss 车载测试 --tab 4 --deep --keep

# 汇总与自检
node scripts/report.mjs --crawled-after 2026-10-19T01:00:00Z
node scripts/check-links.mjs output/候选岗位-20261019-170000.md
```

参数写错会直接报错退出，不会静默走默认值 —— 避免打错一个字母就误触发一次全量抓取。

## 配置说明

| 文件 | 作用 |
|---|---|
| `config/keywords.json` | 搜索词、城市与城市码、启用渠道、相关度规则、方向排除、外包名单 |
| `config/sites.json` | 两站 URL 模板、DOM 选择器、验证码检测、延迟与分页参数 |
| `config/resume-profile.md` | 简历画像：硬性条件、经验、技能、意向、加减分项。匹配打分的唯一依据 |

**修改筛选范围只动 `keywords.json`；站点改版只动 `sites.json`；两者都不需要改代码。**

## 项目结构

```
config/
├── keywords.json              # 搜索词 + 城市 + 渠道 + 相关度/方向排除
├── sites.json                 # 两站 URL 模板 + 选择器 + 延迟参数
├── resume-profile.example.md  # 简历画像模板（复制为 resume-profile.md 后填写）
└── resume-profile.md          # 个人简历画像（gitignore，不入库）
scripts/
├── safari-crawl.mjs           # Safari 抓取主流程 ★
├── probe-safari.mjs           # 探查页面结构，输出选择器体检报告
├── report.mjs                 # 过滤 + 生成候选表
├── check-links.mjs            # 交付物链接自检
└── lib/
    ├── common.mjs             # 路径 / 配置 / 参数解析 / 延迟 / URL / 外包打标
    ├── safari.mjs             # AppleScript 驱动真实 Safari
    ├── safari.applescript     # AppleScript 脚本
    ├── pagejs.mjs             # 页面内字段提取 + 字体反爬解码
    └── store.mjs              # jobs.json 读写与去重合并
data/jobs.json                 # 累加的历史岗位库（gitignore）
output/                        # 候选表与匹配表产物（gitignore）
```

## 工作原理

1. `safari-crawl.mjs` 先列出 Safari 标签页，确认 AppleScript 链路可用
2. 每个「站点 × 关键词」新开一个标签页，导航到搜索页并等待 `location.href` 真正变化
3. 等待页面字体加载完成后，在页面内注入提取脚本，滚动驱动加载更多卡片
4. 提取标题、公司、薪资、地区、经验、学历、标签、链接；BOSS 的薪资码位现场解码
5. 规范化字段、标记外包/猎头、按 `jobId` 或复合键合并进 `jobs.json`
6. 关闭自己开的标签页（异常与 Ctrl-C 路径同样处理）
7. `report.mjs` 按渠道、行业门槛、相关度、方向排除进行过滤，生成候选表

## 已知限制

- **不提供发布时间** — 两站搜索结果页都不暴露岗位发布时间，投递前请自行确认更新时间
- **猎聘只取第一页** — 分页尚未打通；BOSS 为无限滚动
- **平台相关性有限** — 搜索「车载测试」也会返回销售、讲师、船务岗位，由 `report.mjs` 兜底过滤
- **站点改版会导致选择器失效** — 用 `probe-safari.mjs` 重新体检，更新 `sites.json`
- **仅支持 macOS** — 依赖 Safari + AppleScript

## 使用须知

- 本项目仅供个人求职使用，**只读检索**：不投递、不发消息、不修改站点数据
- 不提供任何验证码破解能力；遇到验证码请停止脚本并人工处理
- 不读取、不导出、不记录你的登录态
- 请控制抓取频率，遵守目标网站的使用条款；因使用不当造成的后果由使用者自行承担

## 许可证

本项目仅供学习和个人求职使用。
