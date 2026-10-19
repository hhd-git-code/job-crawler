/**
 * 在用户真实的 Safari 里探一次搜索页，报出页面结构，供固化选择器用。
 *
 *   node scripts/probe-safari.mjs                       # BOSS + 车载测试，新开标签页
 *   node scripts/probe-safari.mjs boss 车载测试
 *   node scripts/probe-safari.mjs boss 车载测试 --tab 4  # 复用已开着的标签页（不再发请求）
 *
 * 设计要点：只导航一次。后续所有探查都在同一个已加载的页面里跑 JS，
 * 不产生任何网络请求 —— BOSS 的限流就是被高频请求触发的，不能再犯。
 */
import { listTabs, openTab, closeTabSafe, waitReady, runJSJson } from './lib/safari.mjs';
import {
  readConfig, buildSearchUrl, sleep, hostOf,
  parseArgs, usageText, failArgs, parsePositiveInt,
} from './lib/common.mjs';

const SPEC = {
  '--tab':  { value: true,  desc: '复用已开着的标签页下标（复用则不再导航、也不再发请求）' },
  '--deep': { value: false, desc: '深挖：打印卡片字段结构、锚点、外链、字体反爬验证' },
  '--keep': { value: false, desc: '跑完不关标签页' },
  '--help': { value: false, desc: '显示本说明' },
};
const EXAMPLE = `  node scripts/probe-safari.mjs boss 车载测试
  node scripts/probe-safari.mjs boss 车载测试 --tab 4 --deep --keep`;

const { opts, positionals, unknown, missingValue, help } = parseArgs(process.argv.slice(2), SPEC);
if (help) {
  console.log(
    `探一次搜索页的 DOM 结构，供固化 config/sites.json 的选择器用（BOSS / 猎聘）\n\n` +
    `用法：node scripts/probe-safari.mjs [站点] [关键词] [选项]\n\n选项：\n${usageText(SPEC)}\n\n示例：\n${EXAMPLE}`
  );
  process.exit(0);
}
if (missingValue.length) failArgs('probe-safari.mjs', SPEC, `${missingValue.join('、')} 后面要跟一个值`, EXAMPLE);
if (unknown.length) failArgs('probe-safari.mjs', SPEC, `不认识的参数：${unknown.join('、')}`, EXAMPLE);
if (positionals.length > 2) {
  failArgs('probe-safari.mjs', SPEC, `多出来的参数：${positionals.slice(2).join('、')}（只接受 [站点] [关键词]）`, EXAMPLE);
}
const tabArg = parsePositiveInt(opts.tab);
if (tabArg === null) failArgs('probe-safari.mjs', SPEC, `--tab 要是正整数，拿到的是「${opts.tab}」`, EXAMPLE);

const reuseTab = tabArg ?? null;
const keep = !!opts.keep;
const deep = !!opts.deep;

const siteKey = positionals[0] || 'boss';
const keyword = positionals[1] || '车载测试';

const sitesCfg = readConfig('sites.json');
const kwCfg = readConfig('keywords.json');
const site = sitesCfg.sites[siteKey];
if (!site) {
  console.error(`未知站点：${siteKey}。可选：${Object.keys(sitesCfg.sites).join(' / ')}`);
  process.exit(1);
}

const city = kwCfg.cities[kwCfg.activeCity];
if (!city) {
  console.error(`未知城市：${kwCfg.activeCity}。可选：${Object.keys(kwCfg.cities).join(' / ')}`);
  process.exit(1);
}
// 缺城市码会拼出 city=undefined，静默探成别的城市。
if (site.searchUrlTemplate?.includes('{city}') && !city.codes?.[siteKey]) {
  console.error(`站点 ${siteKey} 缺少城市「${city.name}」的城市码（keywords.json → cities.${kwCfg.activeCity}.codes.${siteKey}）`);
  process.exit(1);
}
const url = buildSearchUrl(site, keyword, city.codes[siteKey], 1);

console.log(`站点：${site.name}   关键词：${keyword}   城市：${city.name}`);

let tab = reuseTab;
if (tab === null) {
  console.log(`\n在 Safari 中新开标签页：\n  ${url}`);
  tab = await openTab(url);
  console.log(`  标签页下标 ${tab}（${keep ? '--keep：跑完保留' : '用完我会关掉'}；中途 Ctrl-C 中断的话请手动关）`);
} else {
  console.log(`\n复用标签页 ${tab}，不发起新导航`);
}

// 就绪判据用「有岗位卡片」而不是 readyState —— 风控清空文档时 readyState 照样是 complete。
// 候选 = config 里配的 + 一批通用兜底，方便站点改版后一次探到新结构
const CARD_SELECTORS = [
  ...new Set([
    ...(site.cardSelectors ?? []),
    'li.job-card-wrapper',
    '.job-card-wrapper',
    '.job-card-box',
    '.job-list-box li',
    'ul.job-list-box > li',
    '.job-list-container li',
    '.job-detail-box',
  ]),
];

try {
  // 探不到卡片也要继续出报告 —— 这正是站点改版后最需要看的时候，不能在这里就退出
  let info;
  try {
    info = await waitReady(
      tab,
      `return document.querySelector(${JSON.stringify(CARD_SELECTORS.join(','))}) !== null;`,
      { timeoutMs: 40000, label: '搜索结果' }
    );
    console.log(`\n已就绪：${info.href}`);
  } catch (e) {
    console.log(`\n⚠️  没等到已知的卡片选择器命中，直接按当前 DOM 出报告。`);
    console.log(`     （${e.message.split('：')[0]}）`);
    info = await runJSJson(
      `return { href: location.href, state: document.readyState, dom: document.documentElement.innerHTML.length };`,
      tab
    );
    console.log(`   ${info.href}`);
  }
  console.log(`  DOM ${info.dom} 字符`);

  const report = await runJSJson(
    `var out = { title: document.title, href: location.href, cards: [], loginWall: [] };
     var sels = ${JSON.stringify(CARD_SELECTORS)};
     for (var i = 0; i < sels.length; i++) {
       try {
         out.cards.push({ selector: sels[i], count: document.querySelectorAll(sels[i]).length });
       } catch (e) {
         // 单个选择器写错不该让整份体检报告崩掉
         out.cards.push({ selector: sels[i], count: 0, error: '非法选择器' });
       }
     }
     var wall = ['[class*=login]', '[class*=verify]', '[class*=captcha]', '.dialog-wrap', '.boss-login-dialog'];
     for (var j = 0; j < wall.length; j++) {
       var els = document.querySelectorAll(wall[j]);
       if (els.length) out.loginWall.push({ selector: wall[j], count: els.length, text: (els[0].innerText || '').slice(0, 80) });
     }
     // 有没有「登录」按钮，用于判断登录态
     out.hasLoginBtn = !!document.querySelector('.header-login-btn, [ka="header-login"]');
     out.hasUserNav  = !!document.querySelector('.user-nav, .header-user, [ka="header-user"]');
     var best = null;
     for (var k = 0; k < out.cards.length; k++) {
       if (out.cards[k].count > 0 && (!best || out.cards[k].count > best.count)) best = out.cards[k];
     }
     if (best) {
       var el = document.querySelector(best.selector);
       out.sampleSelector = best.selector;
       out.sampleText = (el.innerText || '').slice(0, 600);
       out.sampleClass = el.className;
       out.sampleChildClasses = Array.prototype.slice.call(el.children, 0, 8).map(function (c) { return c.tagName + '.' + c.className; });
     }
     return out;`,
    tab
  );

  console.log(`\n页面标题：${report.title}`);
  console.log(`登录态：${report.hasUserNav ? '✅ 已登录（有用户导航）' : report.hasLoginBtn ? '⚠️ 有登录按钮，可能未登录' : '？ 未识别'}`);

  console.log(`\n──── 卡片选择器命中数 ────`);
  for (const c of report.cards) {
    const mark = c.error ? '❌' : c.count > 0 ? '✅' : '  ';
    console.log(`  ${mark} ${String(c.count).padStart(4)}  ${c.selector}${c.error ? `  （${c.error}）` : ''}`);
  }

  if (report.loginWall?.length) {
    console.log(`\n⚠️  命中疑似登录/验证浮层：`);
    for (const w of report.loginWall) console.log(`   ${w.count}× ${w.selector}  「${w.text}」`);
  }

  if (report.sampleText) {
    console.log(`\n──── 首个卡片（${report.sampleSelector}）────`);
    console.log(`  class: ${report.sampleClass}`);
    console.log(`  子元素: ${report.sampleChildClasses.join('  ')}`);
    console.log('  ── 文本 ──');
    console.log(report.sampleText.split('\n').map((l) => '    ' + l).join('\n'));
  } else {
    console.log('\n⚠️  没有命中任何卡片选择器 —— 需要换一组候选，或页面结构变了。');
  }

  if (deep && report.sampleSelector) {
    const detail = await runJSJson(
      `var el = document.querySelector(${JSON.stringify(report.sampleSelector)});
       if (!el) return { error: '卡片不存在' };
       var fields = {
         title:    ['.job-name', '.job-title', '.job-card-left .job-name', 'a .job-name', '.name'],
         salary:   ['.salary', '.job-salary', '.red', '.job-info .salary'],
         area:     ['.job-area', '.job-area-wrapper', '.job-info .job-area'],
         tags:     ['.tag-list li', '.job-tags span', '.job-card-footer .tag-list li', '.tags span'],
         company:  ['.company-name', '.company-name a', '.job-card-right .company-name', '[class*=company-name]'],
         companyInfo: ['.company-info', '.company-tag-list li'],
         jobLink:  ['a.job-card-left', 'a[href*="job_detail"]', 'a[ka*="job"]']
       };
       var out = { fields: {}, anchors: [] };
       for (var k in fields) {
         out.fields[k] = fields[k].map(function (s) {
           var n = el.querySelector(s);
           return { selector: s, count: el.querySelectorAll(s).length, text: n ? (n.innerText || n.value || '').replace(/\\s+/g, ' ').slice(0, 80) : '', href: n && n.href ? n.href : (n && n.getAttribute ? (n.getAttribute('href') || '') : '') };
         });
       }
       var as = el.querySelectorAll('a[href]');
       for (var i = 0; i < Math.min(as.length, 6); i++) out.anchors.push(as[i].getAttribute('href').slice(0, 160));
       out.html = el.outerHTML.slice(0, 2500);
       return out;`,
      tab
    );

    console.log('\n\n════════ 卡片字段结构 ════════');
    for (const [field, list] of Object.entries(detail.fields ?? {})) {
      console.log(`\n  [${field}]`);
      for (const f of list) {
        if (f.count > 0) console.log(`    ✅ ${String(f.count).padStart(3)}  ${f.selector.padEnd(38)} ${f.text || ''}${f.href ? `  → ${f.href}` : ''}`);
      }
    }
    console.log('\n  [卡片内 a[href]]');
    for (const h of detail.anchors ?? []) console.log(`    ${h}`);
    console.log('\n  ── outerHTML（前 2500 字符）──');
    console.log(detail.html);

    // 薪资数字是否被自定义字体替换（BOSS 的经典反爬手法：文本里读不到真实数字）
    const salarySel = (site.fields?.salary ?? [])[0] || '.job-salary';
    const font = await runJSJson(
      `var SEL = ${JSON.stringify(salarySel)};
       var out = [];
       var els = document.querySelectorAll(SEL);
       for (var i = 0; i < Math.min(els.length, 5); i++) {
         var e = els[i];
         var cs = getComputedStyle(e);
         out.push({ text: e.textContent, html: e.innerHTML.slice(0, 200), font: cs.fontFamily });
       }
       var codes = [];
       var e0 = document.querySelector(SEL);
       if (e0) for (var c = 0; c < e0.textContent.length; c++) codes.push(e0.textContent.charCodeAt(c).toString(16));

       // 分页：BOSS 新版列表可能是无限滚动（"加载更多"）而非页码
       var pager = [];
       var all = document.querySelectorAll('a, button, div, span, li');
       var seen = {};
       for (var q = 0; q < all.length; q++) {
         var t = (all[q].innerText || '').trim();
         var cls = String(all[q].className || '');
         if ((t === '下一页' || t === '加载更多' || t === '查看更多' || t === '2' || t === '3') && !seen[t + cls]) {
           seen[t + cls] = 1;
           pager.push({ tag: all[q].tagName, cls: cls.slice(0, 60), text: t, ka: all[q].getAttribute('ka') || '' });
         }
         if (/page|pager|pagination/i.test(cls) && pager.length < 20 && !seen['c' + cls]) {
           seen['c' + cls] = 1;
           pager.push({ tag: all[q].tagName, cls: cls.slice(0, 60), text: t.slice(0, 40), ka: all[q].getAttribute('ka') || '' });
         }
       }
       return { salaries: out, charCodes: codes, pager: pager };`,
      tab
    );

    console.log('\n  ── 薪资节点（查是否被自定义字体替换）──');
    for (const s of font.salaries) {
      console.log(`    text="${s.text}"  font=${s.font}`);
      console.log(`      html: ${s.html}`);
    }
    console.log(`\n  首条薪资的字符码：${(font.charCodes ?? []).join(' ')}`);

    // 字体反爬破解验证：只在站点配置了 salaryDecode 时才跑（猎聘没有）。
    // 参数全部读 site.salaryDecode，避免探测脚本和正式解码器各写一套、慢慢漂移。
    if (site.salaryDecode) {
      const sd = site.salaryDecode;
      const [W, H] = sd.canvas ?? [48, 56];
      const [PUA_MIN, PUA_MAX] = sd.puaRange ?? [0xE000, 0xF8FF];
      const REF = sd.referenceChars ?? '0123456789';
      const FONT = sd.fontStack ?? 'sans-serif';

      const map = await runJSJson(
        `var SEL = ${JSON.stringify(salarySel)};
         var FONT = ${JSON.stringify(FONT)};
         var W = ${W}, H = ${H};
         var cv = document.createElement('canvas');
         cv.width = W; cv.height = H;
         var ctx = cv.getContext('2d', { willReadFrequently: true });
         function bits(ch) {
           ctx.clearRect(0, 0, W, H);
           ctx.font = FONT;
           ctx.fillStyle = '#000';
           ctx.textBaseline = 'top';
           ctx.fillText(ch, 4, 4);
           var d = ctx.getImageData(0, 0, W, H).data;
           var out = '';
           for (var i = 3; i < d.length; i += 4) out += d[i] > 128 ? '1' : '0';
           return out;
         }
         function dist(a, b) { var n = 0; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; }
         var refs = {};
         ${JSON.stringify(REF)}.split('').forEach(function (d) { refs[d] = bits(d); });
         var pua = {};
         var els = document.querySelectorAll(SEL);
         for (var i = 0; i < els.length; i++) {
           var t = els[i].textContent;
           for (var j = 0; j < t.length; j++) {
             var c = t.charCodeAt(j);
             if (c >= ${PUA_MIN} && c <= ${PUA_MAX}) pua[t[j]] = 1;
           }
         }
         var keys = Object.keys(pua);
         var res = [];
         for (var k = 0; k < keys.length; k++) {
           var sig = bits(keys[k]);
           var ranked = Object.keys(refs).map(function (d) { return { d: d, n: dist(sig, refs[d]) }; })
             .sort(function (a, b) { return a.n - b.n; });
           res.push({ code: 'U+' + keys[k].charCodeAt(0).toString(16).toUpperCase(), ink: sig.split('1').length - 1, best: ranked[0].d, bestDist: ranked[0].n, second: ranked[1].d, secondDist: ranked[1].n });
         }
         return { samples: res, distinctPua: keys.length, salaryCount: els.length };`,
        tab
      );

      console.log(`\n  ── 字体反爬：私用区码位还原 ──`);
      console.log(`  共 ${map.salaryCount} 个薪资节点，出现 ${map.distinctPua} 个不同私用区码位`);
      for (const s of map.samples) {
        const margin = s.secondDist - s.bestDist;
        console.log(`    ${s.code}  墨点=${String(s.ink).padStart(3)}  → 猜「${s.best}」(差${s.bestDist})  次选「${s.second}」(差${s.secondDist})  ${s.bestDist === 0 ? '像素级完全相同 ✅' : margin > s.bestDist * 2 ? 'margin 足够 ✅' : '⚠️ margin 太小，存疑'}`);
      }
    }

    console.log('\n  ── 分页 / 加载更多 ──');
    for (const p of font.pager ?? []) {
      console.log(`    ${p.tag}  class="${p.cls}"  ka="${p.ka}"  文本="${p.text}"`);
    }
  }

  // 提示必须和 finally 的实际行为一致，否则会同时打印「保持打开」和「已关闭」
  if (reuseTab !== null) {
    console.log(`\n（--tab 模式：标签页 ${tab} 保持打开，可继续复用）`);
  } else if (keep) {
    console.log(`\n（--keep：标签页 ${tab} 保持打开，看完请手动关掉）`);
  }
} finally {
  if (!keep && reuseTab === null) {
    await sleep(300);
    // closeTabSafe：关之前按 host 核对，下标万一指到用户自己的标签页上就不动它
    const r = await closeTabSafe(tab, hostOf(site.homeUrl)).catch((e) => ({ closed: false, reason: e.message }));
    console.log(r.closed ? `\n已关闭标签页 ${tab}` : `\n⚠️  没关标签页 ${tab}：${r.reason}`);
  } else {
    console.log(`\n标签页 ${tab} 保留未关。用完记得关：osascript -e 'tell application "Safari" to tell window 1 to close tab ${tab}'`);
  }
}

// 顺带确认用户原来的三个标签还在
const tabs = await listTabs();
console.log(`\n当前 Safari 标签页：`);
for (const t of tabs) console.log(`  W${t.window}T${t.tab}  ${t.name.slice(0, 40)}`);
