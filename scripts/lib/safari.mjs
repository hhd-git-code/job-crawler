/**
 * 驱动用户真实的 Safari（走 Apple Events，不是 Playwright）。
 *
 * 适用场景：站点用 Playwright 抓不到（IP 风控 / 指纹识别），但用户在 Safari 里
 * 已经登录且能正常浏览。这时借用用户自己的浏览器会话，浏览器侧零自动化痕迹。
 *
 * 前提设置：Safari → 设置（⌘,）→ 高级 → 勾选「显示网页开发者功能」→
 *           开发标签页 → 勾选「允许来自 Apple Events 的 JavaScript」
 * 未开启时报错：You must enable 'Allow JavaScript from Apple Events' ... (8)
 *
 * 红线：本模块只做读取。不点投递、不发消息、不改用户已有标签页的内容。
 *       自己开的标签页用完自己关。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, hostOf } from './common.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'safari.applescript');

/** 调一次 AppleScript。用 execFile 而非 exec —— 不经 shell，参数原样传递，无需转义 */
async function osa(...args) {
  try {
    const { stdout } = await execFileAsync('osascript', [SCRIPT, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    });
    return stdout.replace(/\n+$/, '');
  } catch (e) {
    const msg = `${e.stderr || ''}${e.message || ''}`.trim();
    if (msg.includes('Allow JavaScript from Apple Events')) {
      throw new Error(
        'Safari 未开启「允许来自 Apple Events 的 JavaScript」。\n' +
        '  设置路径：Safari → 设置（⌘,）→ 高级 → 勾选「显示网页开发者功能」\n' +
        '            → 切到「开发」标签页 → 勾选「允许来自 Apple Events 的 JavaScript」'
      );
    }
    throw new Error(`osascript 失败：${msg}`);
  }
}

/** 列出所有窗口的所有标签页 */
export async function listTabs() {
  const raw = await osa('list');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [w, t, name, url] = line.split('\u001f');
      return { window: Number(w), tab: Number(t), name, url };
    });
}

/**
 * 新开标签页并切过去，返回标签页下标。用完务必 closeTabSafe 收掉。
 * 必须校验返回值：osascript 返回空串时 Number('') 是 0，后续会误把 0 号标签页
 * 当成自己开的 —— 那是用户已有的标签页（红线）。
 */
export async function openTab(url) {
  const raw = await osa('open', url);
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`打开标签页失败：Safari 返回的下标是「${raw}」`);
  }
  return index;
}

async function closeTab(tabIndex) {
  return osa('close', String(tabIndex));
}

/**
 * 关标签页之前先核对它还是不是「我们那一个」。返回 { closed, reason }。
 *
 * 为什么不直接用 closeTab：AppleScript 全程作用在 window 1，而**标签页下标是会变的** ——
 * 抓取一次要 8–15 分钟，这期间用户自己开一个、关一个标签页，下标就指到别人身上了，
 * 直接 close 会把用户的页面关掉。「不动用户已有的标签页」是项目红线，所以宁可少关一个，
 * 也不能关错一个。
 *
 * 核对依据是 host（我们只可能关自己开在那个站点上的标签页）。
 * 读不到标签页列表时同样不关 —— 拿不准就不动手。
 */
export async function closeTabSafe(tabIndex, expectedHost) {
  let tabs;
  try {
    tabs = await listTabs();
  } catch (e) {
    return { closed: false, reason: `读不到标签页列表（${e.message}），为安全起见没关` };
  }

  const t = tabs.find((x) => x.window === 1 && x.tab === tabIndex);
  if (!t) return { closed: false, reason: '标签页已经不在了（可能被手动关了）' };

  const host = hostOf(t.url);
  if (expectedHost && host !== expectedHost) {
    return { closed: false, reason: `它现在开的是「${t.name || t.url}」，不是本次抓取的站点，没动它` };
  }

  await closeTab(tabIndex);
  return { closed: true, reason: '' };
}

/**
 * 把一段 JS 包成「返回值 base64 编码后带回」的形式。
 *
 * 为什么必须 base64：do JavaScript 的返回值要穿过 AppleScript 的字符串层，
 * 直接返回 JSON 会被引号、换行、反斜杠搞坏。base64 只含 [A-Za-z0-9+/=]，绝对安全。
 */
function wrapExpr(body) {
  return `(function () {
  try {
    var v = (function () { ${body} })();
    // 一律 JSON.stringify，字符串也不例外：解码后要交给 JSON.parse，
    // 裸字符串「https://...」不是合法 JSON，会解析失败。
    // 曾经写成 typeof v === 'string' ? v : JSON.stringify(v)，结果所有返回字符串的调用静默失败。
    var s = JSON.stringify(v);
    if (s === undefined || s === null) s = 'null';
    var bytes = new TextEncoder().encode(s);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'B64:' + btoa(bin);
  } catch (e) {
    return 'ERR:' + (e && e.message ? e.message : String(e));
  }
})()`;
}

/**
 * 在指定标签页里跑 JS，返回解析后的值。
 * body 是一段函数体，用 return 把结果交出来。
 *
 *   await runJSJson('return document.title;', 2)
 *   await runJSJson('return [...document.querySelectorAll(".job-card")].map(el => el.innerText);', 2)
 */
export async function runJSJson(body, tabIndex) {
  const raw = await osa('js', wrapExpr(body), String(tabIndex));
  if (raw.startsWith('ERR:')) throw new Error(`页面内 JS 报错：${raw.slice(4)}`);
  if (!raw.startsWith('B64:')) {
    throw new Error(`返回值格式异常（页面可能正在跳转）：${raw.slice(0, 200)}`);
  }
  return JSON.parse(Buffer.from(raw.slice(4), 'base64').toString('utf8'));
}

/**
 * 轮询等页面就绪。
 * readyExpr 是一段返回布尔值的 JS 函数体，为真才算加载完成。
 * 不只看 readyState —— BOSS/猎聘 的风控会返回 200 但清空文档，
 * readyState 照样是 complete，必须用实际的 DOM 特征判断。
 */
export async function waitReady(tabIndex, readyExpr, { timeoutMs = 60000, label = '页面' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '（还没读到任何状态）';
  while (Date.now() < deadline) {
    try {
      const info = await runJSJson(
        `var ready = (function () { ${readyExpr} })();
         return { href: location.href, state: document.readyState, dom: document.documentElement.innerHTML.length, ready: !!ready };`,
        tabIndex
      );
      last = `${info.href}  state=${info.state}  DOM=${info.dom}  就绪=${info.ready}`;
      if (info.ready) return info;
    } catch (e) {
      last = e.message;
    }
    await sleep(1200);
  }
  throw new Error(`等待${label}超时。最后状态：${last}`);
}

/**
 * 让当前标签页跳到新 URL。
 * 赋值后页面立刻开始卸载，do JavaScript 常常拿不到返回值 —— 那是正常的，不算失败。
 */
export async function navigate(tabIndex, url) {
  await runJSJson(`location.href = ${JSON.stringify(url)}; return 1;`, tabIndex).catch(() => {});
}

/**
 * 等 location.href 变成目标 URL。
 *
 * 为什么必须等：给 location.href 赋值之后，旧文档不会立刻消失 ——
 * 这期间旧页面上的卡片还在，如果直接判「有卡片就算就绪」，会读到上一个关键词的结果，
 * 而且完全不报错。实测 BOSS 是整页加载，所以旧文档一旦被替换，href 必然变成新 URL。
 */
export async function waitForUrl(tabIndex, url, { timeoutMs = 30000 } = {}) {
  const want = url.split('#')[0];
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = await runJSJson(`return location.href;`, tabIndex);
      if (last.split('#')[0] === want) return last;
    } catch {
      /* 正在卸载，读不到属正常，继续轮询 */
    }
    await sleep(400);
  }
  throw new Error(`等待 URL 跳转到目标超时。当前：${last}\n  目标：${want}`);
}

/**
 * 无限滚动列表：反复滚到底，直到卡片数不再增长。
 *
 * 为什么不能在页面里一次跑完：scroll 之后要靠页面自己的 JS 去拉下一批数据，
 * 而 do JavaScript 拿不到 Promise（AppleScript 只能取到同步返回值）。
 * 用同步忙等会把页面主线程堵死，反而永远加载不出来。所以只能来回往返。
 *
 * 每次往返约 0.2-0.5s，配合 settleMs 的等待，一轮约 3s。
 */
export async function scrollUntilStable(tabIndex, countExpr, { maxRounds = 8, settleMs = 2500 } = {}) {
  const countOf = async () => {
    try {
      return await runJSJson(countExpr, tabIndex);
    } catch {
      return -1;
    }
  };

  let prev = await countOf();
  if (prev < 0) return { count: 0, rounds: 0, reason: '读不到卡片数' };

  for (let r = 1; r <= maxRounds; r++) {
    await runJSJson(
      `window.scrollTo(0, document.documentElement.scrollHeight);
       var sc = document.scrollingElement || document.documentElement;
       if (sc) sc.scrollTop = sc.scrollHeight;
       return window.scrollY;`,
      tabIndex
    );
    await sleep(settleMs);

    const now = await countOf();
    if (now <= prev) {
      // 滚到底了。把页面拉回顶部再提取，和真人操作一致
      await runJSJson(`window.scrollTo(0, 0); return 0;`, tabIndex).catch(() => {});
      await sleep(600);
      return { count: prev, rounds: r, reason: now < 0 ? '读取失败，按上次结果算' : '已到底' };
    }
    prev = now;
  }

  await runJSJson(`window.scrollTo(0, 0); return 0;`, tabIndex).catch(() => {});
  return { count: prev, rounds: maxRounds, reason: `达到最大轮次 ${maxRounds}` };
}
