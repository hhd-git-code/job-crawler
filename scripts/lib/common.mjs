/**
 * 通用基础工具：路径常量、配置读取、随机延迟、URL 拼接、岗位字段处理。
 *
 * 约定：本文件不 import 任何浏览器相关模块，保持纯净。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '../..');
const CONFIG_DIR = path.join(ROOT, 'config');
export const DATA_DIR = path.join(ROOT, 'data');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在 [min, max] 毫秒间取随机值，避免固定节奏被识别 */
export const randBetween = ([min, max]) => Math.floor(min + Math.random() * (max - min));

export function readConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8'));
}

/** 取 URL 的 hostname，取不到（about:blank 之类）返回 ''。用于核对标签页身份，见 closeTabSafe */
export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 统一的命令行参数解析 —— 所有脚本共用。
 *
 * 为什么必须拒绝不认识的参数：`node scripts/safari-crawl.mjs --help` 以前既不报错也不出说明，
 * 未知参数被静默忽略，脚本直接开始全量抓取 —— 10 个关键词 × 2 站、8–15 分钟，
 * 而且每一次请求都在往站点的限流计数器上撞（本项目最大的坑就是限流撞成封锁）。
 * 打错一个字母的代价是「误触发一次真实抓取」。同类的还有 `--crawled-after` 拼错：
 * report.mjs 会静默按整个历史库出表，结果看着完全正常但是错的。
 * 所以：不认识就报错，绝不猜。这条比「容错」重要得多。
 *
 * spec 形如：
 *   { '--site': { value: true,  desc: '站点，逗号分隔' },
 *     '--dry':  { value: false, desc: '试跑，不落盘' } }
 * value 为 true 表示后面跟一个值，false 表示布尔开关。
 *
 * 返回 { opts, positionals, unknown, missingValue, help }。
 * 刻意不在这里 process.exit —— 怎么报错、怎么退出交给调用方，逻辑也才好单测。
 */
export function parseArgs(argv, spec) {
  const opts = {};
  const positionals = [];
  const unknown = [];
  const missingValue = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      opts.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const def = spec[a];
    if (!def) {
      unknown.push(a);
      continue;
    }
    if (!def.value) {
      opts[a.slice(2)] = true;
      continue;
    }
    const v = argv[i + 1];
    // 空串 / 纯空白也算没给值：否则 `--keyword ""` 会被调用方当成「没传」，
    // 静默跑成全部关键词；`--crawled-after ""` 会静默按整个历史库出表。
    if (v === undefined || v.trim() === '' || v.startsWith('--')) {
      missingValue.push(a);
      continue;
    }
    opts[a.slice(2)] = v;
    i++;
  }

  return { opts, positionals, unknown, missingValue, help: !!opts.help };
}

/** 由 spec 生成参数说明。保证「打印出来的说明」和「实际认得的参数」是同一份真相 */
export function usageText(spec) {
  return Object.entries(spec)
    .map(([flag, d]) => `  ${(flag + (d.value ? ' <值>' : '')).padEnd(24)} ${d.desc}`)
    .join('\n');
}

/** 参数有问题就打印原因 + 说明 + 示例然后退出。所有脚本共用一套报错格式 */
export function failArgs(scriptName, spec, problem, example = '') {
  console.error(`参数错误：${problem}\n`);
  console.error(`用法：node scripts/${scriptName} [选项]\n`);
  console.error(usageText(spec));
  if (example) console.error(`\n示例：\n${example}`);
  process.exit(1);
}

/**
 * 解析「必须是正整数」的参数。
 * 返回 undefined = 没传；null = 传了但不合法（调用方负责报错）。
 *
 * 为什么要单独做这件事：`--max-keywords abc` 以前会变成 NaN，
 * `keywords.slice(0, NaN)` 是空数组 —— 脚本安静地跑完 0 个关键词、打印「共 0 次搜索」，
 * 看起来像「今天没岗位」，其实一个请求都没发。
 */
export function parsePositiveInt(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 文件名时间戳，格式 YYYYMMDD-HHMMSS（别直接切 ISO 串，带点的毫秒会漏进文件名） */
export function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 拼搜索 URL。站点模板都带 {kw} / {city} / {page} 三个占位符。
 * 抓取和探查脚本共用，避免各自手拼、改一处漏一处。
 */
export function buildSearchUrl(site, keyword, cityCode, pageNum) {
  return site.searchUrlTemplate
    .replace('{kw}', encodeURIComponent(keyword))
    .replace('{city}', encodeURIComponent(cityCode))
    .replace('{page}', String(pageNum));
}

/** 外包/驻场打标：关键词 + 公司名双重匹配（公司名不区分大小写） */
export function detectOutsourcing(job, cfg) {
  const haystack = [job.company, job.title, job.rawText].join(' ').toLowerCase();
  for (const kw of cfg.keywords) {
    if (haystack.includes(kw.toLowerCase())) return { isOutsourcing: true, outsourcingReason: `关键词:${kw}` };
  }
  const company = (job.company ?? '').toLowerCase();
  for (const co of cfg.companies) {
    if (company.includes(co.toLowerCase())) return { isOutsourcing: true, outsourcingReason: `公司:${co}` };
  }
  return { isOutsourcing: false, outsourcingReason: '' };
}
