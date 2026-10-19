/**
 * 交付物链接自检：把 Markdown 里所有岗位链接，逐条回查 data/jobs.json。
 *
 * 为什么必须有这一步：交付物是给用户真去点的。链接一旦是编的或改坏的，
 * 用户点开发现对不上岗位，整份报告的可信度就没了。这一步就是防这个。
 *
 *   node scripts/check-links.mjs output/岗位匹配表-20261014-153000.md
 *   node scripts/check-links.mjs output/*.md
 *
 * 退出码：全部命中 = 0；有未命中 = 1（方便接进流程做卡点）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJobs, JOBS_FILE } from './lib/store.mjs';

const files = process.argv.slice(2);
// 这个脚本没有选项，只吃文件路径。传了 --xxx 就直说 —— 否则会走成「文件不存在：--help」，
// 看不出是参数用错了
const flags = files.filter((f) => f.startsWith('--'));
if (flags.length) {
  console.error(`本脚本不接受选项，只吃 Markdown 文件路径。多出来的：${flags.join('、')}`);
  process.exit(2);
}
if (files.length === 0) {
  console.error('用法：node scripts/check-links.mjs <markdown 文件> [更多文件...]');
  process.exit(2);
}

/**
 * 把岗位 URL 归一成「站点:岗位ID」。
 * 当前只抓 BOSS直聘 / 猎聘，两个站的 URL 结构不同，但都带稳定的岗位 ID。
 */
function canonical(url) {
  const m =
    url.match(/zhipin\.com\/job_detail\/([\w~-]+)\.html/) ??
    url.match(/liepin\.com\/(?:job|a)\/(\d+)\.shtml/);
  if (!m) return null;
  const site = /zhipin/.test(url) ? 'boss' : 'liepin';
  return `${site}:${m[1]}`;
}

const jobs = readJobs();
if (jobs.length === 0) {
  console.error(`无数据：${JOBS_FILE} 不存在或为空`);
  process.exit(2);
}

// 键 → 岗位。同一岗位可能在库里有多条（不同关键词抓到），保留一条即可
const index = new Map();
for (const j of jobs) {
  const key = canonical(j.url ?? '');
  if (key && !index.has(key)) index.set(key, j);
}

let totalLinks = 0;
let unmatched = 0;
let unparsable = 0;
const seen = new Set(); // 跨文件去重，避免同一岗位重复报

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`文件不存在：${file}`);
    process.exit(2);
  }
  const md = fs.readFileSync(file, 'utf8');

  // 只取 Markdown 链接里看起来像岗位详情的 URL
  const urls = [...md.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
  const jobUrls = urls.filter((u) => /zhipin\.com\/job_detail|liepin\.com\/(job|a)\//.test(u));

  console.log(`\n──── ${path.basename(file)} ────`);
  console.log(`  Markdown 链接 ${urls.length} 条，其中岗位链接 ${jobUrls.length} 条`);

  // 两种问题分开计：「库里查无此岗位」和「URL 形态不认识」。
  // 以前把 missing.length（含形态异常）整个加进 unmatched，两个数字互相包含，
  // 汇总行读起来像「未命中 X 条、形态异常 Y 条」共 X+Y，其实是 X 里已经含了 Y。
  const missing = [];
  for (const u of jobUrls) {
    const key = canonical(u);
    if (!key) {
      unparsable++;
      missing.push({ u, why: 'URL 形态不认识' });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    totalLinks++;
    if (!index.has(key)) {
      unmatched++;
      missing.push({ u, why: '库里查无此岗位' });
    }
  }

  if (missing.length === 0) {
    console.log(`  ✅ 全部命中 data/jobs.json`);
  } else {
    console.log(`  ❌ ${missing.length} 条有问题：`);
    for (const m of missing) console.log(`     ${m.why}  ${m.u}`);
  }
}

console.log(`\n════ 汇总 ════`);
console.log(`  核验岗位链接 ${totalLinks} 条：库里查无此岗位 ${unmatched} 条，URL 形态不认识 ${unparsable} 条`);
if (unmatched + unparsable > 0) {
  console.log(`  ⚠️  这两种链接都不要留在交付物里 —— 要么是编的，要么 jobs.json 里没有。删掉或核实后重写。`);
  process.exit(1);
}
console.log(`  ✅ 交付物里每一条链接都能在数据里找到对应岗位`);
