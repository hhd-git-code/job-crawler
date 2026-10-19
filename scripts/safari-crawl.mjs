/**
 * 走 Safari + AppleScript 的抓取主流程。
 *
 * 直接指挥用户已经登录好的 Safari，不另起浏览器进程。BOSS 用 Playwright 会被
 * 清空成 about:blank（详见 CLAUDE.md），不要再试。
 *
 *   node scripts/safari-crawl.mjs --site boss --keyword 车载测试        # 先拿一个词试跑
 *   node scripts/safari-crawl.mjs --site boss --max-keywords 3
 *   node scripts/safari-crawl.mjs --site boss,liepin
 *   node scripts/safari-crawl.mjs --site boss --tab 4                   # 复用已开着的标签页
 *   node scripts/safari-crawl.mjs --site boss --keyword 车载测试 --dry   # 只探结构不落盘
 *   node scripts/safari-crawl.mjs --help                                # 看参数说明
 *
 * 前提：Safari → 设置 → 开发 → 勾选「允许来自 Apple Events 的 JavaScript」。
 *
 * 红线：只读。不点投递、不发消息、不动用户已有的标签页。自己开的标签页结束时自己关。
 */
import {
  listTabs, openTab, closeTabSafe, navigate, waitForUrl, waitReady, runJSJson, scrollUntilStable,
} from './lib/safari.mjs';
import {
  readConfig, buildSearchUrl, sleep, randBetween, detectOutsourcing,
  parseArgs, usageText, failArgs, parsePositiveInt, hostOf,
} from './lib/common.mjs';
import { buildExtractExpr, buildReadyExpr, buildCountExpr } from './lib/pagejs.mjs';
import { mergeJobs, JOBS_FILE } from './lib/store.mjs';

const SPEC = {
  '--site':         { value: true,  desc: '站点，逗号分隔。可选 boss / liepin，默认两个都跑' },
  '--keyword':      { value: true,  desc: '只抓这一个关键词（默认跑 keywords.json 里的 10 个）' },
  '--max-keywords': { value: true,  desc: '最多抓几个关键词（正整数）' },
  '--city':         { value: true,  desc: '城市 key，默认 keywords.json 的 activeCity' },
  '--tab':          { value: true,  desc: '复用已开着的标签页下标。复用模式下不会自动关闭' },
  '--dry':          { value: false, desc: '试跑：只打印不落盘' },
  '--keep-tab':     { value: false, desc: '跑完不关自己开的标签页（留着手动看）' },
  '--help':         { value: false, desc: '显示本说明' },
};
const EXAMPLE = `  node scripts/safari-crawl.mjs --site boss --max-keywords 2 --dry   # 先拿两个词试跑
  node scripts/safari-crawl.mjs --site boss,liepin                   # 两站全量（8–15 分钟）`;

const { opts, positionals, unknown, missingValue, help } = parseArgs(process.argv.slice(2), SPEC);
if (help) {
  console.log(
    `Safari 路线抓取（BOSS直聘 / 猎聘）—— 指挥用户已登录的 Safari，不走 Playwright\n\n` +
    `用法：node scripts/safari-crawl.mjs [选项]\n\n选项：\n${usageText(SPEC)}\n\n示例：\n${EXAMPLE}\n\n` +
    `前提：Safari → 设置（⌘,）→ 开发 → 勾选「允许来自 Apple Events 的 JavaScript」`
  );
  process.exit(0);
}
if (missingValue.length) failArgs('safari-crawl.mjs', SPEC, `${missingValue.join('、')} 后面要跟一个值`, EXAMPLE);
if (unknown.length) failArgs('safari-crawl.mjs', SPEC, `不认识的参数：${unknown.join('、')}`, EXAMPLE);
if (positionals.length) {
  failArgs('safari-crawl.mjs', SPEC, `多出来的参数：${positionals.join('、')}（站点/关键词要用 --site / --keyword 传）`, EXAMPLE);
}
const maxKeywordsArg = parsePositiveInt(opts['max-keywords']);
if (maxKeywordsArg === null) failArgs('safari-crawl.mjs', SPEC, `--max-keywords 要是正整数，拿到的是「${opts['max-keywords']}」`, EXAMPLE);
const tabArg = parsePositiveInt(opts.tab);
if (tabArg === null) failArgs('safari-crawl.mjs', SPEC, `--tab 要是正整数，拿到的是「${opts.tab}」`, EXAMPLE);

const sitesCfg = readConfig('sites.json');
const kwCfg = readConfig('keywords.json');
const common = sitesCfg.common;

const dry = !!opts.dry;
const keepTab = !!opts['keep-tab'];
const reuseTab = tabArg ?? null;

const siteFilter = opts.site ?? null;
const keywordFilter = opts.keyword ?? null;
const maxKeywords = maxKeywordsArg ?? Infinity;
const cityKey = opts.city ?? kwCfg.activeCity;
const city = kwCfg.cities[cityKey];
if (!city) {
  console.error(`未知城市：${cityKey}。可选：${Object.keys(kwCfg.cities).join(' / ')}`);
  process.exit(1);
}

// 不传 --site 时按 keywords.json 的 activeSites 跑。
// 去重：`--site boss,boss` 会把同一站完整抓两遍，白白撞限流计数器。
const DEFAULT_SITES = Array.isArray(kwCfg.activeSites) ? kwCfg.activeSites : ['boss', 'liepin'];
const rawSites = siteFilter ? siteFilter.split(',') : DEFAULT_SITES;
const siteKeys = [...new Set(rawSites.map((s) => s.trim()).filter(Boolean))];
if (!siteKeys.length) {
  console.error('没有可抓的站点：--site 或 keywords.json 的 activeSites 为空');
  process.exit(1);
}
for (const sk of siteKeys) {
  const site = sitesCfg.sites[sk];
  if (!site) {
    console.error(`未知站点：${sk}。可选：${Object.keys(sitesCfg.sites).join(' / ')}`);
    process.exit(1);
  }
  // 需要城市参数的站点必须配好城市码。缺了会拼出 city=undefined，
  // 静默搜成别的城市 —— 数据看着完全正常，但是错的。
  if (site.searchUrlTemplate?.includes('{city}') && !city.codes?.[sk]) {
    console.error(`站点 ${sk} 缺少城市「${city.name}」的城市码（keywords.json → cities.${cityKey}.codes.${sk}）`);
    process.exit(1);
  }
}

let keywords = keywordFilter ? [keywordFilter] : kwCfg.keywords;
keywords = keywords.slice(0, maxKeywords);

const startedAt = new Date().toISOString();
console.log(`城市 ${city.name} ｜ 站点 ${siteKeys.join(', ')} ｜ 关键词 ${keywords.length} 个`);
console.log(`模式 ${dry ? '试跑（不落盘）' : '正式抓取'}`);
console.log(`本次开始（UTC）：${startedAt}\n`);

// 先确认 Safari 在跑、AppleScript 能通，否则后面全是无效请求
try {
  const tabs = await listTabs();
  console.log(`Safari 在线，当前 ${tabs.length} 个标签页：`);
  for (const t of tabs) console.log(`  W${t.window}T${t.tab}  ${t.name.slice(0, 36)}  ${t.url.slice(0, 70)}`);
  console.log();
} catch (e) {
  console.error(`连不上 Safari：${e.message}`);
  process.exit(1);
}

let allJobs = [];
let requestCount = 0;
const problems = [];

/** 本次自己开出来的标签页：下标 → 站点。正常路径、异常路径、Ctrl-C 都要按它收尾 */
const openedTabs = new Map();

/**
 * 关掉一个「我们自己开的」标签页。
 * 走 closeTabSafe 而不是裸 closeTab：AppleScript 全程作用在 window 1，而下标在抓取途中
 * 可能已经指到用户自己新开的那个标签页上了 —— 直接关就会关掉用户的页面（项目红线）。
 */
async function closeOurTab(tabIndex, site) {
  const r = await closeTabSafe(tabIndex, hostOf(site.homeUrl))
    .catch((e) => ({ closed: false, reason: e.message }));
  openedTabs.delete(tabIndex);
  if (r.closed) console.log(`  已关闭标签页 ${tabIndex}`);
  else console.log(`  ⚠️  没关标签页 ${tabIndex}：${r.reason}`);
}

/**
 * 收尾：把还没关掉的、自己开的标签页全关掉。
 * 循环里已经逐个关过了，这里兜的是「中间抛异常」「被 Ctrl-C」这些路径 ——
 * 以前那种情况下标签页会一直留在用户浏览器里。
 */
async function cleanupTabs() {
  // 必须串行，且按下标从大到小关：关掉一个标签页会让它后面的下标整体前移。
  // 并发会让两个 closeTabSafe 基于同一份快照关闭；升序则会让下一个下标漂移。
  // 两者都可能把「我们自己的标签页」指到用户页面上 —— 那是项目红线。
  const entries = [...openedTabs].sort((a, b) => b[0] - a[0]);
  for (const [t, site] of entries) await closeOurTab(t, site);
}

// Ctrl-C / 被 kill 时也别把自己的标签页留在用户浏览器里。
// 整体最多等 3 秒（closeTabSafe 的 osascript 自带超时，这里再兜一层），到点直接退。
let exiting = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (exiting) return; // 连按两次 Ctrl-C 不要并发清理
    exiting = true;
    console.log(`\n收到 ${sig}，正在把本次打开的标签页关掉…`);
    Promise.race([cleanupTabs(), sleep(3000)]).then(() => process.exit(130));
  });
}

/** 把页面提取结果规范化成本项目统一的岗位字段 */
function normalize(raw, siteKey, site, keyword) {
  const roleRe = {
    degree: new RegExp(site.tagRoles?.degree ?? '^\\b$'),
    experience: new RegExp(site.tagRoles?.experience ?? '^\\b$'),
  };

  let degree = '';
  let experience = '';
  const leftoverTags = [];
  for (const t of raw.tags ?? []) {
    if (!degree && roleRe.degree.test(t)) degree = t;
    else if (!experience && roleRe.experience.test(t)) experience = t;
    else leftoverTags.push(t);
  }

  // 站点间写法不一（BOSS 是 9-14K，猎聘是 10-15k），统一成大写 K
  const salary = (raw.salary ?? '').replace(/(\d)\s*([kK])/g, '$1K').replace(/\s+/g, '');

  // 两个站的详情页 URL 形态不同，分别取 id（猎聘同时有 /job/ 和 /a/ 两种）
  const jobId =
    (raw.url?.match(/job_detail\/([\w~-]+)\.html/) ?? [])[1] ??
    (raw.url?.match(/liepin\.com\/(?:job|a)\/(\d+)\.shtml/) ?? [])[1] ??
    '';

  const recruiter = raw.recruiter ?? '';

  const job = {
    site: siteKey,
    siteName: site.name,
    keyword,
    jobId,
    title: raw.title ?? '',
    company: raw.company ?? '',
    salary,
    salaryRaw: raw.salaryRaw ?? '',
    city: city.name,
    area: raw.area ?? '',
    experience,
    degree,
    recruiter,
    // 猎头代招 ≠ 外包，但值得单独标出来：投过去先过一层猎头，反馈慢
    isHeadhunter: /猎头|人才顾问|招聘顾问/.test(recruiter),
    tags: leftoverTags,
    url: raw.url ?? '',
    rawText: raw.rawText ?? '',
    crawledAt: new Date().toISOString(),
  };
  Object.assign(job, detectOutsourcing(job, kwCfg.outsourcing));
  return job;
}

/** 登录墙 / 验证码判定：落点 URL 最能说明问题 */
function detectWall(finalUrl) {
  if (/\/web\/user\//.test(finalUrl) || /_security_check/.test(finalUrl) || /[?&]sign=1/.test(finalUrl)) {
    return '被踢到登录页 —— Safari 里的登录态可能过期了';
  }
  if (/\/login/i.test(finalUrl) || /passport\./.test(finalUrl)) {
    return '被踢到登录页 —— 登录态过期';
  }
  return null;
}

/**
 * 页面里的验证码 / 风控浮层检测。配置来自 sites.json 的 captchaCheck：
 * `{ selectors: [CSS...], texts: [可见文字...] }`。
 *
 * **只检测、不破解**：命中就停手，交给用户在 Safari 里手动过。这是项目红线。
 * 只在「等不到卡片」的失败路径上调用，正常页面不会走到这里。
 */
async function detectCaptcha(tabIndex, site) {
  const css = site.captchaCheck?.selectors ?? [];
  const texts = site.captchaCheck?.texts ?? [];
  if (!css.length && !texts.length) return '';

  try {
    const hit = await runJSJson(
      `var css = ${JSON.stringify(css)}, texts = ${JSON.stringify(texts)};
       for (var i = 0; i < css.length; i++) {
         var els;
         try { els = document.querySelectorAll(css[i]); } catch (e) { continue; }
         // 模板里预埋的隐藏浮层不算，必须真的有尺寸
         for (var k = 0; k < els.length; k++) {
           var r = els[k].getBoundingClientRect();
           if (r.width > 0 && r.height > 0) {
             return { selector: css[i], text: (els[k].innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
           }
         }
       }
       var body = document.body ? (document.body.innerText || '') : '';
       for (var j = 0; j < texts.length; j++) {
         if (body.indexOf(texts[j]) >= 0) return { selector: 'text=' + texts[j], text: texts[j] };
       }
       return null;`,
      tabIndex
    );
    return hit ? `${hit.selector}${hit.text ? `「${hit.text}」` : ''}` : '';
  } catch {
    return ''; // 检测本身失败就当没测到，别因此把正常流程打断
  }
}

try {
  for (const sk of siteKeys) {
    const site = sitesCfg.sites[sk];
    const siteJobs = [];
    console.log(`\n════════ ${site.name} ════════`);

    let tab = reuseTab;
    if (tab === null) {
      // 先落到站点首页拿会话，再进搜索页 —— 直接开搜索页容易触发风控
      console.log(`  新开标签页：${site.homeUrl}`);
      tab = await openTab(site.homeUrl);
      openedTabs.set(tab, site);
      console.log(`  标签页下标 ${tab}`);
      await waitReady(tab, `return document.readyState === 'complete';`, { timeoutMs: 45000, label: '首页' })
        .catch((e) => console.log(`  ⚠️  ${e.message}`));
      await sleep(randBetween(common.keywordDelayMs));
    }

    // 同一站连续失败 N 个关键词就停手。被限流时每个关键词都要干等 waitReady 超时（45 秒），
    // 10 个词就是把限流计数器连撞 10 次 —— 正是 CLAUDE.md 里「把猎聘 IP 打封」的那个操作。
    // 宁可少抓一批，也不能把偶发限流升级成持续封锁。
    const MAX_FAIL_STREAK = 2;
    let failStreak = 0;
    /** 记一次失败，返回 true 表示该停手了 */
    const noteFail = () => {
      if (++failStreak < MAX_FAIL_STREAK) return false;
      console.log(`  ⛔ 连续 ${failStreak} 个关键词失败，疑似被限流 —— 主动停止本站，不再发请求。`);
      console.log(`     不要马上重跑：越重试封锁越久。等 30 分钟以上，并在 Safari 里手动确认站点能正常打开。`);
      return true;
    };

    for (let k = 0; k < keywords.length; k++) {
      const kw = keywords[k];
      const url = buildSearchUrl(site, kw, city.codes[sk], 1);

      // 延迟放在循环开头，不放在结尾：上一个关键词无论成功还是失败都要等。
      // （以前放在结尾，而几条失败分支用的是 continue —— 会把延迟整个跳过去，
      //   也就是出问题的时候反而请求得更密，正好跟该做的事相反）
      if (k > 0) await sleep(randBetween(common.keywordDelayMs));

      process.stdout.write(`  ${kw.padEnd(14, '　')}`);
      requestCount++;

      try {
        // 每个关键词都显式导航，第一个也不例外 —— 标签页是先开在站点首页的。
        // 而且必须等 URL 真的变过去：只判「有卡片」的话，旧文档被替换前的那一刻还在，
        // 会静默读到上一个关键词的结果
        await navigate(tab, url);
        await waitForUrl(tab, url);

        let info;
        try {
          info = await waitReady(tab, buildReadyExpr(site), { timeoutMs: 45000, label: `${kw} 搜索页` });
        } catch (e) {
          // 登录页没有岗位卡片，waitReady 必然先超时 —— 所以必须在这条失败路径上
          // 先看落点 URL，否则永远只会报「等待搜索页超时」，看不出是登录态过期。
          const finalUrl = await runJSJson('return location.href;', tab).catch(() => '');
          const wall = detectWall(finalUrl);
          if (wall) {
            console.log(`❌ ${wall}`);
            problems.push({ site: sk, keyword: kw, reason: wall, url: finalUrl });
            break; // 整站都别跑了
          }

          // 等到超时的另一个常见原因就是弹了验证码。单独查一次，给出明确原因。
          const captcha = await detectCaptcha(tab, site);
          if (captcha) {
            console.log(`❌ 出现验证码/风控验证：${captcha}`);
            console.log('     请切到 Safari 手动完成验证，再重跑本脚本。已停手，不会继续发请求。');
            problems.push({ site: sk, keyword: kw, reason: `验证码：${captcha}` });
            break; // 人不动手，后面每个词都会撞同一堵墙
          }
          throw e;
        }

        const wall = detectWall(info.href);
        if (wall) {
          console.log(`❌ ${wall}`);
          problems.push({ site: sk, keyword: kw, reason: wall, url: info.href });
          break; // 整站都别跑了
        }

        // 核对页面确实换成了这次的关键词。读旧数据是最难发现的错误 —— 数据看着都对，只是不是这次的
        if (site.queryEchoSelector) {
          const echoed = await runJSJson(
            `var i = document.querySelector(${JSON.stringify(site.queryEchoSelector)});
             return i ? i.value : '';`,
            tab
          ).catch(() => '');
          if (echoed && !echoed.includes(kw)) {
            console.log(`❌ 搜索框回显的是「${echoed}」，不是「${kw}」—— 页面没换成目标关键词`);
            problems.push({ site: sk, keyword: kw, reason: `关键词回显不符：${echoed}` });
            if (noteFail()) break;
            continue;
          }
        }

        // 无限滚动列表：滚到底把岗位全部加载出来
        if (site.pagination?.mode === 'scroll') {
          const r = await scrollUntilStable(tab, buildCountExpr(site), {
            maxRounds: site.pagination.maxRounds ?? 8,
            settleMs: site.pagination.settleMs ?? 2500,
          });
          process.stdout.write(`[滚动${r.rounds}轮→${r.count}条] `);
        }

        const res = await runJSJson(buildExtractExpr(site), tab);
        if (!res.selector) {
          console.log('❌ 卡片选择器全部失效，需重跑 probe-safari.mjs --deep 看新结构');
          problems.push({ site: sk, keyword: kw, reason: '选择器失效' });
          if (noteFail()) break;
          continue;
        }

        // 字体解码自检：不同码位解出同一个数字 = 字体没加载完或换了，结果不可信
        const codes = Object.keys(res.salaryMapping ?? {});
        if (codes.length >= 5 && res.puaConflicts > 0) {
          console.log(`⚠️ 薪资字体解码有 ${res.puaConflicts} 处冲突（${codes.length} 个码位），薪资可能不准`);
          problems.push({ site: sk, keyword: kw, reason: `薪资解码冲突 ${res.puaConflicts}` });
        }

        const jobs = res.jobs.map((j) => normalize(j, sk, site, kw));
        siteJobs.push(...jobs);
        const withSalary = jobs.filter((j) => /\d/.test(j.salary)).length;
        console.log(`→ ${String(jobs.length).padStart(2)} 条（薪资可读 ${withSalary}）[${res.selector}]`);
        failStreak = 0; // 这个关键词成了，连续失败计数归零

        if (dry) {
          for (const j of jobs.slice(0, 5)) {
            console.log(`      ${j.salary.padEnd(9)} ${j.experience.padEnd(7)} ${(j.degree || '-').padEnd(4)} ${j.area.padEnd(14)} ${j.company.slice(0, 12)}｜${j.title.slice(0, 30)}${j.isOutsourcing ? `  [外包:${j.outsourcingReason}]` : ''}`);
          }
        }
      } catch (e) {
        console.log(`❌ ${e.message.split('\n')[0]}`);
        problems.push({ site: sk, keyword: kw, reason: e.message.split('\n')[0] });
        if (noteFail()) break;
      }
    }

    if (siteJobs.length) console.log(`  ── ${site.name}: ${siteJobs.length} 条`);
    allJobs.push(...siteJobs);

    if (reuseTab === null && !keepTab) {
      await closeOurTab(tab, site);
    } else {
      console.log(`  标签页 ${tab} 保留未关`);
    }
  }
} catch (e) {
  // 把异常翻译成人能看懂的一句话，别让用户面对一坨堆栈
  console.error(`\n❌ 抓取中途出错，已停止：${e.message}`);
  process.exitCode = 1;
} finally {
  if (reuseTab === null && !keepTab && openedTabs.size) await cleanupTabs();
  if (reuseTab !== null) console.log(`\n（--tab 模式的标签页不会自动关闭）`);
  else if (keepTab && openedTabs.size) {
    console.log(`\n（--keep-tab：标签页 ${[...openedTabs.keys()].join('、')} 保留未关 —— 看完记得自己关掉）`);
  }
}

console.log(`\n════════ 汇总 ════════`);
console.log(`  共 ${requestCount} 次搜索，提取 ${allJobs.length} 条`);

const withSalary = allJobs.filter((j) => /\d/.test(j.salary)).length;
const withUrl = allJobs.filter((j) => j.url).length;
console.log(`  薪资可读 ${withSalary}/${allJobs.length}   有链接 ${withUrl}/${allJobs.length}`);

if (!dry && allJobs.length) {
  const result = mergeJobs(allJobs);
  console.log(`  合并入库：新增 ${result.added}，更新 ${result.updated}，总计 ${result.total}`);
  console.log(`  数据文件：${JOBS_FILE}`);
}

if (problems.length) {
  console.log(`\n⚠️  ${problems.length} 处异常：`);
  for (const p of problems) console.log(`   ${p.site} / ${p.keyword}  ${p.reason}`);
}

if (!dry && allJobs.length) {
  console.log(`\n下一步：node scripts/report.mjs --crawled-after ${startedAt}`);
  console.log('（输出路径看 report.mjs 打印的「输出：」）');
}
