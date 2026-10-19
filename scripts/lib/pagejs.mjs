/**
 * 生成「在目标页面里执行」的 JS。
 *
 * 为什么要整段生成而不是逐步往返：每次 osascript 调用都有几百毫秒开销，
 * 而且 BOSS 对高频请求敏感。整页提取一次跑完、一次取回，往返次数压到最低。
 *
 * 选择器全部从 config/sites.json 注入，这里不硬编码任何站点结构。
 */

/** 把配置里的候选选择器逐个试，返回第一个有内容的文本 */
const PICK_TEXT = `
function pickText(el, sels) {
  for (var i = 0; i < sels.length; i++) {
    var n = el.querySelector(sels[i]);
    if (n) {
      var t = (n.textContent || '').replace(/\\s+/g, ' ').trim();
      if (t) return t;
    }
  }
  return '';
}
function pickList(el, sels) {
  for (var i = 0; i < sels.length; i++) {
    var ns = el.querySelectorAll(sels[i]);
    if (ns.length) {
      var out = [];
      for (var j = 0; j < ns.length; j++) {
        var t = (ns[j].textContent || '').replace(/\\s+/g, ' ').trim();
        if (t) out.push(t);
      }
      if (out.length) return out;
    }
  }
  return [];
}
function pickAttr(el, sels, attr) {
  for (var i = 0; i < sels.length; i++) {
    var n = el.querySelector(sels[i]);
    if (n) {
      var v = n.getAttribute(attr);
      if (v) return v;
    }
  }
  return '';
}
/** 卡片选择器取「命中数最多」的那个，不盲目信配置顺序 */
function bestCardSelector(sels) {
  var best = null;
  for (var i = 0; i < sels.length; i++) {
    var n = document.querySelectorAll(sels[i]).length;
    if (n > 0 && (!best || n > best.count)) best = { sel: sels[i], count: n };
  }
  return best;
}
`;

/**
 * 字体反爬解码器。BOSS 把薪资数字换成私用区码位（U+E031=0 … U+E03A=9），
 * 靠 kanzhun-mix 字体画出真实数字，直接读文本只能拿到「-K」。
 *
 * 破解思路：页面里用 canvas 把码位画出来，和 0-9 的像素逐位比对，取最近的那个。
 * 实测 10 个码位全部像素级完全相同（距离 0），次选距离 ≥87，没有歧义。
 *
 * 不写死映射表 —— 字体文件随时可能换，现场比对才是稳的。
 */
const SALARY_DECODER = `
function makeDecoder(cfg) {
  if (!cfg) return { decode: function (s) { return s; }, mapping: {}, conflicts: 0 };
  var W = cfg.canvas[0], H = cfg.canvas[1];
  var cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  var ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { decode: function (s) { return s; }, mapping: {}, conflicts: 0 };

  function bits(ch) {
    ctx.clearRect(0, 0, W, H);
    ctx.font = cfg.fontStack;
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'top';
    ctx.fillText(ch, 4, 4);
    var d = ctx.getImageData(0, 0, W, H).data;
    var out = '';
    for (var i = 3; i < d.length; i += 4) out += d[i] > 128 ? '1' : '0';
    return out;
  }
  function dist(a, b) {
    var n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
  }

  var refs = [], refChars = [];
  for (var k = 0; k < cfg.referenceChars.length; k++) {
    var c = cfg.referenceChars[k];
    refs.push(bits(c));
    refChars.push(c);
  }

  var cache = {};
  var mapping = {};
  function decode(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code >= cfg.puaRange[0] && code <= cfg.puaRange[1]) {
        var ch = str[i];
        if (cache[ch] === undefined) {
          var sig = bits(ch), best = '', bestD = Infinity;
          for (var j = 0; j < refChars.length; j++) {
            var d = dist(sig, refs[j]);
            if (d < bestD) { bestD = d; best = refChars[j]; }
          }
          cache[ch] = best;
          mapping['U+' + code.toString(16).toUpperCase()] = best;
        }
        out += cache[ch];
      } else {
        out += str[i];
      }
    }
    return out;
  }

  return {
    decode: decode,
    get mapping() { return mapping; },
    get conflicts() {
      var seen = {}, dup = 0;
      for (var k in mapping) { if (seen[mapping[k]]) dup++; seen[mapping[k]] = 1; }
      return dup;
    }
  };
}
`;

/**
 * 生成整页提取脚本。返回 { selector, jobs, salaryMapping, puaConflicts } ——
 * 一次调用把整页岗位全部取回。
 *
 * 只收 site 一个参数：关键词和城市是调用方 normalize 时才用的，页面里不需要知道。
 */
export function buildExtractExpr(site) {
  const cfg = {
    cardSelectors: site.cardSelectors ?? [],
    fields: site.fields ?? {},
    linkSelector: site.linkSelector ?? 'a[href]',
    salaryDecode: site.salaryDecode ?? null,
    textExtract: site.textExtract ?? null,
    excludeFromText: site.excludeFromText ?? [],
    maxCards: site.pagination?.maxCards ?? 200,
  };

  return `
var CFG = ${JSON.stringify(cfg)};
${PICK_TEXT}
${SALARY_DECODER}

var dec = makeDecoder(CFG.salaryDecode);

/** 正则兜底：站点把类名改成哈希之后，结构选择器随时会废，卡片纯文本反而更稳 */
function firstMatch(text, src) {
  if (!src) return '';
  try { var m = text.match(new RegExp(src)); return m ? m[0].replace(/\\s+/g, '') : ''; }
  catch (e) { return ''; }
}

var best = bestCardSelector(CFG.cardSelectors);
if (!best) return { selector: null, count: 0, jobs: [], salaryMapping: {}, puaConflicts: 0 };

var cards = document.querySelectorAll(best.sel);
var jobs = [];
var seen = {};
var te = CFG.textExtract;

for (var i = 0; i < cards.length && jobs.length < CFG.maxCards; i++) {
  var el = cards[i];
  var raw = (el.innerText || '').trim();
  if (raw.length < 5) continue;

  // 卡片里有些区块（比如猎聘的招聘者栏）不该参与文本匹配：
  // 那栏写着「×××·猎头顾问」，留着会让 outsourcing 的关键词把一大片岗位误标成外包
  if (CFG.excludeFromText.length) {
    var clone = el.cloneNode(true);
    for (var x = 0; x < CFG.excludeFromText.length; x++) {
      var kill = clone.querySelectorAll(CFG.excludeFromText[x]);
      for (var y = 0; y < kill.length; y++) kill[y].parentNode.removeChild(kill[y]);
    }
    raw = (clone.innerText || '').trim();
  }

  var titleRaw = pickText(el, CFG.fields.title || []);
  var salaryRaw = pickText(el, CFG.fields.salary || []);
  var tags = pickList(el, CFG.fields.tags || []);

  // DOM 没取到（或取到的是「【」这种噪音）就退回正则。判据是「里面有没有数字」
  if (te) {
    if (!/[0-9]/.test(salaryRaw)) salaryRaw = firstMatch(raw, te.salary) || salaryRaw;
    if (!tags.length) {
      var ex = firstMatch(raw, te.experience);
      var dg = firstMatch(raw, te.degree);
      if (ex) tags.push(ex);
      if (dg) tags.push(dg);
    }
  }

  var href = pickAttr(el, [CFG.linkSelector], 'href');
  var url = '';
  if (href) { try { url = new URL(href, location.href).href; } catch (e) { url = href; } }

  var job = {
    title: titleRaw,
    company: pickText(el, CFG.fields.company || []),
    salary: dec.decode(salaryRaw),
    salaryRaw: salaryRaw,
    area: pickText(el, CFG.fields.area || []).replace(/^[·\\s]+/, ''),
    recruiter: pickText(el, CFG.fields.recruiter || []),
    tags: tags,
    url: url,
    rawText: raw.slice(0, 600)
  };

  var key = (job.company + '|' + job.title + '|' + job.area).replace(/\\s+/g, '');
  if (seen[key]) continue;
  seen[key] = 1;
  jobs.push(job);
}

return {
  selector: best.sel,
  jobs: jobs,
  salaryMapping: dec.mapping,
  puaConflicts: dec.conflicts
};
`;
}

/** 就绪判据：卡片出现 + 文档完成 + 字体加载完（字体没加载完就解码会全错） */
export function buildReadyExpr(site) {
  const cardSel = JSON.stringify((site.cardSelectors ?? []).join(','));
  const fontCheck = site.salaryDecode
    ? `&& document.fonts && document.fonts.status === 'loaded'`
    : '';
  return `return document.readyState === 'complete' && document.querySelector(${cardSel}) !== null ${fontCheck};`;
}

/**
 * 数当前页卡片数，用于判断滚动是否还在加载。
 * 刻意自包含、不依赖上面的辅助函数 —— 这段会被独立注入执行。
 */
export function buildCountExpr(site) {
  return `var _sels = ${JSON.stringify(site.cardSelectors ?? [])}, _best = 0;
for (var _i = 0; _i < _sels.length; _i++) {
  var _n = document.querySelectorAll(_sels[_i]).length;
  if (_n > _best) _best = _n;
}
return _best;`;
}
