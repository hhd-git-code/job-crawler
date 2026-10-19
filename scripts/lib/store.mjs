import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './common.mjs';

export const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

/**
 * 先写临时文件再 rename，不直接写目标文件：直接写的话，进程要是死在写入中间
 * （Ctrl-C、内存不足、断电），留下的是半截 JSON。rename 在同一文件系统内是原子的：
 * 要么是完整的旧内容，要么是完整的新内容。
 */
function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  return filePath;
}

/**
 * 读累加库。文件不存在返回 []（首次运行）；解析失败或不是数组则**报错停止**。
 *
 * 为什么不能兜底成 []：调用方会把读到的内容当现有库，兜底成空数组再整份写回去，
 * 等于把历史岗位静默清空 —— 不报错、不提示，而 data/ 不入 git，没有第二份可恢复。
 * 所以宁可让脚本停下来，也不能带着空库往下走。
 */
export function readJobs() {
  let text;
  try {
    text = fs.readFileSync(JOBS_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${JOBS_FILE} 解析失败，已停止（继续跑会把整个历史库清空）：${e.message}\n` +
      `  文件 ${text.length} 字节。先把它备份出来，再决定是手工修复还是删掉重抓。`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${JOBS_FILE} 内容不是数组（是个 ${typeof parsed}），已停止以免写坏历史库`);
  }
  return parsed;
}

/** 空字符串 / null / 空数组都算「没抓到」，合并时不能覆盖历史里的好数据 */
function isEmptyValue(v) {
  return v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

/**
 * 去重键：**同一站点的同一个岗位**视为一条。
 *
 * 优先用岗位 ID（最稳）。没有 ID 时才退回公司+岗位+地区。
 * 不要把搜索范围 city 放进来 —— 那是「按哪个城市搜的」，不是岗位所在城市；
 * 换城市抓同一批岗位会全部变成新记录。
 */
function dedupeKey(j) {
  if (j.site && j.jobId) return `id|${j.site}|${j.jobId}`;
  return ['no-id', j.site, j.company, j.title, j.area].join('|').replace(/\s+/g, '');
}

/**
 * 合并进汇总库。
 *
 * 两个时间字段语义不同，别搞混：
 * - `crawledAt` = **最后一次**抓到它的时间。会被本次抓取刷新，所以
 *   `report.mjs --crawled-after <本次开始时间>` 捞到的是「本轮抓到的全部岗位」
 *   （含早已存在、本轮又抓到的）。这正是那个参数的用途。
 * - `firstSeenAt` = **首次**见到它的时间，经兜底后不会被覆盖。
 *   要识别「新出现的岗位」，用这个字段。
 *
 * 合并时空字段保留旧值：选择器或字体解码偶发失败时，不能让一次坏抓取
 * 把历史里完整的薪资、公司、标签覆盖成空。
 */
export function mergeJobs(incoming) {
  const existing = readJobs();
  const map = new Map(existing.map((j) => [dedupeKey(j), j]));

  let added = 0;
  let updated = 0;
  for (const job of incoming) {
    const key = dedupeKey(job);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...job, firstSeenAt: job.crawledAt });
      added++;
      continue;
    }

    const next = { ...prev, ...job, firstSeenAt: prev.firstSeenAt ?? prev.crawledAt };
    for (const [k, v] of Object.entries(job)) {
      if (isEmptyValue(v) && !isEmptyValue(prev[k])) next[k] = prev[k];
    }
    // 招聘者 / 岗位描述没抓到时，由它们推导出来的标记也保留旧值
    if (isEmptyValue(job.recruiter) && !isEmptyValue(prev.recruiter)) {
      next.recruiter = prev.recruiter;
      next.isHeadhunter = prev.isHeadhunter;
    }
    if (isEmptyValue(job.rawText) && !isEmptyValue(prev.rawText)) {
      next.isOutsourcing = prev.isOutsourcing;
      next.outsourcingReason = prev.outsourcingReason;
    }
    map.set(key, next);
    updated++;
  }

  const merged = [...map.values()].sort((a, b) => (a.company ?? '').localeCompare(b.company ?? '', 'zh'));
  writeJson(JOBS_FILE, merged);
  return { added, updated, total: merged.length };
}
