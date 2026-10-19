/**
 * 候选岗位过滤与成表。
 *
 * 平台搜索相关性很差（搜「车载测试」会返回销售、讲师、船务岗位），
 * 这一步按「渠道 + 关键词黑名单 + 方向排除 + 行业门槛 + 相关度」筛一遍，
 * 输出精简候选表，交给人工/AI 做最终匹配打分。
 *
 *   node scripts/report.mjs
 *   node scripts/report.mjs --crawled-after 2026-10-14T06:56:57Z
 *
 * 已知限制：BOSS / 猎聘 的结果页都不暴露发布时间，所以不做时效过滤 ——
 * 抓回来的数据里没有发布时间可用，强行过滤只会静默丢掉全部岗位。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  readConfig, ROOT, timestamp, parseArgs, usageText, failArgs,
} from './lib/common.mjs';
import { readJobs, JOBS_FILE } from './lib/store.mjs';

const SPEC = {
  '--crawled-after': { value: true,  desc: '只统计这个时间之后抓到的岗位（UTC，带 Z）。jobs.json 只增不删，重跑必带' },
  '--out':           { value: true,  desc: '输出文件名，相对路径落在 output/ 下。默认 候选岗位-YYYYMMDD-HHMMSS.md' },
  '--help':          { value: false, desc: '显示本说明' },
};
const EXAMPLE = `  node scripts/report.mjs
  node scripts/report.mjs --crawled-after 2026-10-14T06:56:57Z`;

const { opts, positionals, unknown, missingValue, help } = parseArgs(process.argv.slice(2), SPEC);
if (help) {
  console.log(`候选岗位过滤与成表\n\n用法：node scripts/report.mjs [选项]\n\n选项：\n${usageText(SPEC)}\n\n示例：\n${EXAMPLE}`);
  process.exit(0);
}
if (missingValue.length) failArgs('report.mjs', SPEC, `${missingValue.join('、')} 后面要跟一个值`, EXAMPLE);
if (unknown.length) failArgs('report.mjs', SPEC, `不认识的参数：${unknown.join('、')}`, EXAMPLE);
if (positionals.length) failArgs('report.mjs', SPEC, `多出来的参数：${positionals.join('、')}`, EXAMPLE);

const kwCfg = readConfig('keywords.json');
const sitesCfg = readConfig('sites.json');
const rel = kwCfg.relevance;
const outName = opts.out ?? `候选岗位-${timestamp()}.md`;

// ── 只统计本轮抓到的岗位 ──
// jobs.json 是累加的（mergeJobs 只增不删），重跑时上一轮的岗位还留在里面。
// 那些岗位可能早已下架，混进报告会让人白投。传本次抓取开始的时间戳即可只统计新数据。
const crawledAfter = opts['crawled-after'] ?? null;
const crawledAfterTs = crawledAfter ? Date.parse(crawledAfter) : null;
if (crawledAfter && Number.isNaN(crawledAfterTs)) {
  console.error(`--crawled-after 不是合法时间：${crawledAfter}（示例：2026-10-14T13:00:00+08:00）`);
  process.exit(1);
}

const allJobsRaw = readJobs();

// ── 只统计启用的抓取渠道 ──
// 渠道列表的唯一真相源是 keywords.json 的 activeSites。
const activeSites = new Set(kwCfg.activeSites ?? ['boss', 'liepin']);
const allJobs = [];
const skippedBySite = {};
for (const j of allJobsRaw) {
  if (activeSites.has(j.site)) {
    allJobs.push(j);
  } else {
    const name = j.siteName ?? j.site ?? '未知';
    skippedBySite[name] = (skippedBySite[name] ?? 0) + 1;
  }
}
const skippedChannelCount = allJobsRaw.length - allJobs.length;

const jobs =
  crawledAfterTs === null
    ? allJobs
    : allJobs.filter((j) => Date.parse(j.crawledAt ?? '') >= crawledAfterTs);

if (jobs.length === 0) {
  const skippedNote = skippedChannelCount
    ? `（另有 ${skippedChannelCount} 条属于未启用渠道，已跳过：${JSON.stringify(skippedBySite)}）`
    : '';
  let reason;
  if (allJobsRaw.length === 0) {
    reason = `无数据：${JOBS_FILE} 不存在或为空。先跑 node scripts/safari-crawl.mjs`;
  } else if (crawledAfterTs !== null) {
    reason = `启用渠道共 ${allJobs.length} 条，但没有 ${crawledAfter} 之后抓到的记录 —— 抓取可能没跑成功，或时间戳传错了。`;
  } else {
    reason = `启用渠道没有岗位记录（库中共 ${allJobsRaw.length} 条，属于未启用渠道）。`;
  }
  console.error(reason + skippedNote);
  process.exit(1);
}

/** 相关性打分：strong 权重 3，medium 权重 1 */
function relevanceScore(job) {
  const hay = [job.title, job.company, (job.tags ?? []).join(' '), job.rawText].join(' ').toLowerCase();
  let score = 0;
  const hits = [];
  for (const t of rel.strong) {
    if (hay.includes(t.toLowerCase())) {
      score += 3;
      hits.push(t);
    }
  }
  let mediumHits = 0;
  for (const t of rel.medium) {
    if (hay.includes(t.toLowerCase())) {
      score += 1;
      mediumHits++;
    }
  }
  const excluded = rel.exclude.filter((t) => hay.includes(t.toLowerCase()));

  // 行业门槛：岗位描述里的汽车词，或公司本身属于汽车产业链，命中任一即通过
  const gate = (rel.domainGate?.terms ?? []).filter((t) => hay.includes(t.toLowerCase()));
  const companyHit = (rel.domainGate?.companies ?? []).filter((t) =>
    (job.company ?? '').toLowerCase().includes(t.toLowerCase())
  );
  if (companyHit.length) gate.push(...companyHit.map((c) => `公司:${c}`));

  return { score, hits, mediumHits, excluded, gate };
}

// ── 整类岗位方向剔除（如 ADAS/智驾）──
// 用标题和标签判断，不看公司名 —— 公司做智驾不代表每个岗位都是智驾。
// 英文缩写按词边界匹配，避免 "ACC" 命中 "ACCESS"、"APA" 命中 "APARTMENT" 之类。
const roleCfg = kwCfg.excludeRoles ?? { terms: [], matchIn: ['title', 'tags'] };
const roleFields = roleCfg.matchIn ?? ['title', 'tags'];
const roleTerms = roleCfg.terms ?? [];

function termHit(text, term) {
  const hay = text.toLowerCase();
  const t = term.toLowerCase();
  return /^[a-z0-9]+$/.test(t)
    ? new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(hay)
    : hay.includes(t);
}

function excludedRoleOf(job) {
  const text = roleFields
    .map((f) => (Array.isArray(job[f]) ? job[f].join(' ') : job[f] ?? ''))
    .join(' ');
  return roleTerms.find((t) => termHit(text, t)) ?? '';
}

const scored = [];
const gatedOut = [];
const dropped = { irrelevant: 0, excluded: 0, gated: 0, excludedRole: 0 };

for (const job of jobs) {
  const { score, hits, mediumHits, excluded, gate } = relevanceScore(job);

  if (excluded.length > 0) {
    dropped.excluded++;
    continue;
  }
  // 整类方向剔除（ADAS/智驾等）：放在行业门槛之前，避免它们出现在「被门槛挡掉」附录里
  const roleHit = excludedRoleOf(job);
  if (roleHit) {
    dropped.excludedRole++;
    continue;
  }
  // 行业门槛：一个汽车相关词都没有的，判定为非本行业。
  // 单列进 gatedOut 而不是直接丢，方便事后人工回看有没有误杀。
  if (gate.length === 0) {
    dropped.gated++;
    gatedOut.push({ ...job, _score: score, _hits: [...new Set(hits)] });
    continue;
  }
  // strong 命中 1 个，或 medium 命中 2 个以上，才算相关
  if (hits.length === 0 && mediumHits < 2) {
    dropped.irrelevant++;
    continue;
  }

  scored.push({ ...job, _score: score, _hits: [...new Set(hits)], _gate: gate });
}

gatedOut.sort((a, b) => b._score - a._score);

scored.sort((a, b) => {
  if (b._score !== a._score) return b._score - a._score;
  return (a.company ?? '').localeCompare(b.company ?? '', 'zh');
});

// ── 输出 Markdown ──
/** 表格单元格转义：`|` 会打断列，换行会打断行 */
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const lines = [];
lines.push('# 候选岗位（自动过滤后）');
lines.push('');
lines.push(`生成时间：${new Date().toLocaleString('zh-CN')}`);
const activeSiteNames = [...activeSites].map((k) => sitesCfg.sites?.[k]?.name ?? k);
lines.push(
  `抓取渠道：${activeSiteNames.join(' / ')}` +
    (skippedChannelCount
      ? `（已跳过未启用渠道历史记录 ${skippedChannelCount} 条：${Object.entries(skippedBySite).map(([k, v]) => `${k} ${v}`).join('、')}）`
      : '')
);
lines.push(
  `过滤条件：通过汽车行业门槛 且 相关度达标 且 不属于排除方向。` +
    `原始 ${jobs.length} 条 → 候选 ${scored.length} 条（剔除：非汽车行业 ${dropped.gated}、无关 ${dropped.irrelevant}、排除行业 ${dropped.excluded}、排除方向 ${dropped.excludedRole}）`
);
lines.push('');
lines.push(
  `岗位方向排除（按标题/标签）：${roleTerms.length ? roleTerms.join('、') : '无'}`
);
lines.push('');
// 「外包」和「猎头代招」是两回事：外包 = 不是甲方编制；猎头代招 = 多过一层、反馈慢。
lines.push('| # | 相关度 | 岗位 | 公司 | 薪资 | 地区 | 经验 | 学历 | 外包 | 猎头 | 来源 | 链接 |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');

scored.forEach((j, i) => {
  const cells = [
    i + 1,
    j._score,
    cell(j.title || '—'),
    cell(j.company || '—'),
    cell(j.salary || '—'),
    cell(j.area || j.city || '—'),
    cell(j.experience || '—'),
    cell(j.degree || '—'),
    cell(j.isOutsourcing ? `是(${j.outsourcingReason})` : ''),
    j.isHeadhunter ? '是' : '',
    cell(j.siteName),
    j.url ? `[详情](${j.url})` : '—',
  ];
  lines.push(`| ${cells.join(' | ')} |`);
});

lines.push('');
lines.push(`## 相关度命中词（${scored.length} 条）`);
lines.push('');
// ⚠️ 这里和下面的附录都**不要**截断。曾经两处都写死 slice(0, 40)：
// 附录表头印着「235 条」而底下只列 40 行，看不出来少了。
// 「防止误杀」这份清单的意义全在被挡掉的那几条上（实测从中捞回过错杀的对口岗）。
scored.forEach((j, i) => {
  lines.push(`${i + 1}. **${j.title}** @ ${j.company} — 命中：${j._hits.join('、') || '（仅中等词）'}`);
});

lines.push('');
lines.push('---');
lines.push('');
lines.push(`## 附：被行业门槛挡掉的岗位（${gatedOut.length} 条，全部列出，仅供参考）`);
lines.push('');
lines.push('这些岗位没有任何汽车相关的词，大概率不相关。列出来是防止误杀——如果里面有你想要的，说明门槛该放宽。');
lines.push('');
lines.push('| 岗位 | 公司 | 薪资 | 地区 | 链接 |');
lines.push('|---|---|---|---|---|');
gatedOut.forEach((j) => {
  lines.push(
    `| ${cell(j.title || '—')} | ${cell(j.company || '—')} | ${cell(j.salary || '—')} | ${cell(j.area || '—')} | ${j.url ? `[详情](${j.url})` : '—'} |`
  );
});

const outPath = path.isAbsolute(outName) ? outName : path.join(ROOT, 'output', outName);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

// ── 控制台摘要 ──
console.log(`原始 ${jobs.length} 条 → 候选 ${scored.length} 条`);
console.log(`  渠道：${activeSiteNames.join(' / ')}`);
if (skippedChannelCount) {
  console.log(`  已跳过未启用渠道历史记录 ${skippedChannelCount} 条：${JSON.stringify(skippedBySite)}`);
}
if (crawledAfterTs !== null) console.log(`  （--crawled-after ${crawledAfter}；启用渠道历史累计 ${allJobs.length} 条）`);
console.log(
  `  剔除：非汽车行业 ${dropped.gated}、无关 ${dropped.irrelevant}、排除行业 ${dropped.excluded}、排除方向 ${dropped.excludedRole}`
);
console.log(`  （被行业门槛挡掉的 ${gatedOut.length} 条已**全部**列在报告末尾，务必扫一遍看有没有误杀）`);
console.log(`  其中外包/驻场：${scored.filter((j) => j.isOutsourcing).length} 条，猎头代招：${scored.filter((j) => j.isHeadhunter).length} 条`);
console.log(`\n输出：${outPath}`);

const bySite = {};
for (const j of scored) bySite[j.siteName] = (bySite[j.siteName] ?? 0) + 1;
console.log('  来源分布：', JSON.stringify(bySite, null, 0));
