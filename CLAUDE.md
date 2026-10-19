# 求职岗位抓取

从 BOSS直聘 / 猎聘抓取**全国**范围内的车载测试相关岗位（默认排除 ADAS/智驾方向），
按简历匹配度打分排序，输出投递优先级表。

**目的**：个人求职。只读检索，低频，不对抗验证码。

渠道列表的唯一真相源是 `config/keywords.json` 的 `activeSites`（当前 `boss` / `liepin`），
抓取和报告都读它。

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js v24+（ESM，`type: module`），**无第三方依赖** |
| 浏览器控制 | Safari + AppleScript（使用用户真实登录态） |
| 数据存储 | JSON 文件（无数据库） |
| 配置 | `config/*.json`（可热改，不改代码） |

## 唯一抓取路线：Safari + AppleScript

指挥用户已经登录好的 Safari，不另起浏览器进程、不改 UA、不注入 `navigator.webdriver`。
浏览器侧零自动化痕迹。

**前置设置**（只做一次）：
Safari → 设置（⌘,）→ 高级 → ☑ 显示网页开发者功能 → 切到「开发」标签页 →
☑ **允许来自 Apple Events 的 JavaScript**

⚠️ 这个开关有安全含义：打开后任何拿到「自动化」权限的程序都能往页面里注入 JS。
抓完提醒用户关掉。

**为什么不用 Playwright**：Playwright 起的是「Chrome for Testing」，指纹和真实浏览器有差异，
BOSS / 猎聘会返回 HTTP 200 但把页面清空成 `about:blank`（DOM 只剩 26 字符）。
换到 Safari 后两站都正常 —— 封锁针对的是浏览器指纹和行为，不是 IP。**不要再引入 Playwright。**

### 限流：最大的坑

- 症状：`page.goto()` / 导航返回 200，但 DOM 只剩 `<head></head><body></body>`。
- **不要靠重跑排查。** 越重试封锁越久；猎聘的 IP 曾被打封过。
- 停手等 30 分钟以上，在真实 Safari 里手动访问站点确认恢复。
- `safari-crawl.mjs` 同一站连续失败 2 个关键词就主动停站，并检测验证码后停手交人工。
  原则：**宁可少抓一批，不能把限流撞成封锁。**
- 抓取节奏参数（`config/sites.json` 的 `keywordDelayMs`）只调大不调小。

### BOSS 薪资字体反爬

BOSS 把薪资数字换成 Unicode 私用区码位（U+E031–U+E03A），再用 `kanzhun-mix` 字体画成数字。
直接读文本只能得到 `-K`、`15-K`。

`lib/pagejs.mjs` 的 `makeDecoder` 用 canvas 把码位和 0-9 各画一遍，逐像素比对取最近的字形。
**不写死映射表** —— 字体随时可能换，现场比对才准。

- 就绪判据必须包含 `document.fonts.status === 'loaded'`；字体没加载完就解码会全错。
- 自检：两个不同码位解出同一个数字 → 打印 `⚠️ 薪资字体解码有 N 处冲突`。
- **「薪资可读 = 总条数」是最关键的验收条件。**

### AppleScript 驱动 Safari 的坑

1. `do JavaScript` 顶层不能写 `return`，所有代码必须包进 `(function(){...})()`。
2. 返回值一律 `JSON.stringify`，字符串也不例外；再 base64 编码穿过 AppleScript 字符串层。
   （`lib/safari.mjs` 的 `wrapExpr()` 已统一处理。）
3. 参数用 `execFile('osascript', [脚本, ...参数])` 走 argv，不要用 `osascript -e` 拼字符串。
4. 导航后必须等 `location.href` 真的变了再判就绪，否则会静默读到上一个关键词的结果。
5. 每个关键词都要显式导航，第一个也不例外。
6. 新开标签页的下标必须**从后往前**反查。正着扫会撞上用户自己开着的同 URL 标签页，
   之后所有导航都会落在用户标签页里，结束时还会把它关掉 —— 动了用户标签页是红线。
7. **全程写死 `window 1`。** 抓取期间不要切换 Safari 窗口，丢后台别动它。

无限滚动必须由 Node 侧来回驱动：滚一次 → 等 2.6 秒 → 数卡片数 → 不涨就停。
AppleScript 拿不到 Promise，页面内同步忙等会把主线程堵死。

### 猎聘的坑

- 类名从 kebab 改成驼峰：`.jobCardPcContainer`；局部类名是构建哈希，只能用语义类名和结构选择器。
- `data-tlg-elem-id` 在卡片和内层 `<a>` 上都有，拿它当卡片选择器会把每条岗位数成两条。
- 城市参数是 `dqs`，不是 `city`。全国 = `410`，天津 = `030`，北京 = `010`。
  **不要猜城市码** —— 在筛选面板 `li.options-item[data-key=dq]` 的 `data-code` 上读。
- 招聘者栏每张卡都有「×××·猎头顾问」，已用 `excludeFromText` 剔出文本匹配范围。
  猎头代招 ≠ 外包，单独用 `isHeadhunter` 标。

### 已知限制

- **两站结果页都不暴露发布时间**，数据里没有这个字段。投递前要在页面上自己确认更新时间。
- 猎聘只取第一页（分页未打通）；BOSS 是无限滚动。
- 平台搜索相关性很差：搜「车载测试」会返回销售、讲师、船务岗位，靠 `report.mjs` 兜底过滤。

## 常用命令

```bash
# 抓取（不传 --site 时按 activeSites 跑）
node scripts/safari-crawl.mjs --site boss
node scripts/safari-crawl.mjs --site boss,liepin
node scripts/safari-crawl.mjs --site boss --max-keywords 2 --dry   # 试跑，不落盘
node scripts/safari-crawl.mjs --site boss --keyword 车载测试        # 只跑一个词
node scripts/safari-crawl.mjs --help

# 探页面结构（站点改版时用）
node scripts/probe-safari.mjs boss 车载测试
node scripts/probe-safari.mjs boss 车载测试 --tab 4 --deep --keep

# 汇总与自检（输出名由 report.mjs 自动带日期+时间，不要用 --out 覆盖）
node scripts/report.mjs --crawled-after 2026-10-19T01:00:00Z
node scripts/check-links.mjs output/岗位匹配表-20261019-153000.md
```

- `--crawled-after` 必带：`jobs.json` 只增不删，不带会把上轮已下架的岗位混进来。
  `safari-crawl.mjs` 启动时会打印本次开始时间（UTC），直接复制。
- `safari-crawl.mjs` 自己开标签页、跑完自己关；Ctrl-C / 异常路径也会收掉。
  收不掉会打印 `⚠️ 没关标签页 N：<原因>` —— 拿不准就不动手，宁可不关也不关错。
- 参数写错会直接报错退出，不会静默走默认值。

`job-hunt-match` skill（`~/.claude/skills/job-hunt-match/`）把整条流水线 + 手动打分封装成
`/job-hunt-match`。**改脚本接口时记得同步改 skill。**

## 项目结构

```
config/
├── keywords.json       # 搜索词 + 城市 + 渠道 + 相关度/方向排除。改筛选范围只动这里
├── sites.json          # 两站 URL 模板 + 选择器 + 延迟参数。站点改版只动这里
└── resume-profile.md   # 简历画像：硬性条件/技能/意向/加减分/搜索词。打分的唯一依据
scripts/
├── safari-crawl.mjs    # Safari 主流程 ★
├── probe-safari.mjs    # 探页面结构，出选择器体检报告
├── report.mjs          # 过滤 + 成候选表
├── check-links.mjs     # 交付物链接自检：逐条回查 jobs.json
└── lib/
    ├── common.mjs      # 路径 / 配置 / 参数解析 / 延迟 / URL / 外包打标
    ├── safari.mjs      # AppleScript 驱动真实 Safari
    ├── safari.applescript
    ├── pagejs.mjs      # 页面内提取 + 字体反爬解码
    └── store.mjs       # jobs.json 读写 + 去重合并
data/jobs.json          # 累加的历史岗位库（gitignore，不入库）
output/
├── 候选岗位-YYYYMMDD-HHMMSS.md   # 自动过滤后的候选表（中间产物）
└── 岗位匹配表-YYYYMMDD-HHMMSS.md # 最终交付物
```

## 约定

- 注释用中文，变量/函数名用英文。
- **选择器和 URL 模板只写进 `config/sites.json`**，代码里不硬编码站点结构。
- **`lib/common.mjs` 不许 import 任何浏览器模块**；共用逻辑一律放这里。
- 拼搜索 URL 用 `buildSearchUrl()`，不要手拼 `.replace('{kw}', ...)`。
- **跑哪些站由 `activeSites` 决定**，不要再引入第二处开关。
- 提取逻辑用宽松启发式，宁可多抓不可漏抓，清洗交给下游。
- 抓到的字段一律为字符串，缺失填空字符串 `''`，不用 `null`。
- 文件名用中文或 kebab-case，不混用。
- **`jobs.json` 的合并语义**：
  - `crawledAt` = 最后一次抓到的时间，会被刷新；`--crawled-after` 用它。
  - `firstSeenAt` = 首次见到的时间，不会被覆盖。
  - 去重键：有 `jobId` 用 `site + jobId`，否则用 `site + company + title + area`。
    **不要用搜索范围 `city` 当去重键。**
  - 本次抓取的空字段不得覆盖历史里的非空值（选择器/字体偶发失败时防止数据倒退）。
  - 写入用「临时文件 + rename」；读取解析失败直接报错停止，不兜底成空数组。

## 红线

- **只读。** 不点投递、不发消息、不动用户已有的标签页；自己开的标签页自己关。
- 遇验证码一律停手交人工处理，**不写自动破解逻辑**。
- 登录态只存在用户自己的 Safari 里，脚本不读取、不导出、不记录。
- 单线程串行，不并发，不用代理池。
- 抓取节奏只调大不调小。
- **不主动删除 `data/jobs.json`。** 需要重置历史库时必须先问用户。

## 清理规则

- `output/` 产物一律带日期后缀，不覆盖旧文件。
- `data/jobs.json.tmp` 只在写到一半被打断时残留，可以直接删；下次抓取会覆盖。
- `data/` 体积大、可重跑，已 gitignore。

## 验证方式

| 阶段 | 命令 | 通过标准 |
|---|---|---|
| Safari 权限 | `node --input-type=module -e "const {listTabs}=await import('./scripts/lib/safari.mjs'); console.log((await listTabs()).length)"` | 打印标签页数量，不报「允许来自 Apple Events」 |
| 参数 | `node scripts/<脚本> --help` | 打印参数说明 |
| 结构 | `node scripts/probe-safari.mjs <site> <词>` | 命中卡片选择器 ≥1 个 |
| 提取 | `node scripts/safari-crawl.mjs --site <site> --max-keywords 1 --dry` | 条数 ≥40，**薪资可读 = 总条数**，有链接 = 总条数 |
| 全量 | `node scripts/safari-crawl.mjs --site boss,liepin` | 两站均无 `❌` |

⚠️ **不要把 `safari-crawl.mjs --site boss --dry` 当权限检查** —— 不传 `--max-keywords`
就是 10 个关键词的全量抓取。权限检查只需上面的 `listTabs`，零网络请求。

**「薪资可读 = 总条数」是最关键的一条**：不相等说明字体解码挂了，数据看着正常但全是错的。
