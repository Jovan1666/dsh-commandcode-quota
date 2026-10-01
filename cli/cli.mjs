#!/usr/bin/env node
/**
 * Command Code 额度命令行：把 {@link module:commandcode-quota/lib} 的报告渲染成
 * 人类可读的进度条，或原样输出 JSON；也能只看「模型 → 次数」目录。
 *
 * 默认只读；只有 `--refresh-catalog` 会核对官方一次并更新目录缓存
 * （`$DSH_HOME/dsh-commandcode-quota/catalog.json`）。不依赖 DSH 运行时，因此随时可跑，
 * 不需要重启 GUI。
 *
 * @example
 * node cli.mjs             # 渲染一次
 * node cli.mjs --json      # 给脚本消费
 * node cli.mjs --watch 60  # 每 60 秒刷新
 * node cli.mjs --models    # 模型 → 次数（优先本地，不联网）
 * node cli.mjs --plan individual-max --models   # 指定套餐，离线也能看
 * node cli.mjs --catalog-json > catalog.json    # 同一份目录视图的 JSON
 */

import { readFileSync } from 'node:fs';
import { PLAN_DOC_URLS, formatCount, needsRevalidate, readCatalogCache, readCatalogSeed, resolveCatalogView, syncCatalog } from '../catalog.mjs';
import { DEFAULT_API_BASE, QuotaError, TIMEOUT_ENV_NAME, credentialFingerprint, fetchQuotaReport, quotaSnapshotPath, resolveTimeoutMs } from '../quota.mjs';

const BAR_WIDTH = 28;
const LABEL_WIDTH = 10;

/** 阈值配色：越接近上限越红。 */
const LEVELS = [
  { limit: 60, color: '\u001b[32m' },
  { limit: 85, color: '\u001b[33m' },
  { limit: Number.POSITIVE_INFINITY, color: '\u001b[31m' },
];

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv `process.argv.slice(2)`。
 * @returns {{ json: boolean, watchSeconds?: number, ascii: boolean, color: boolean, apiBase: string, timeoutMs: number, apiKey?: string, models: boolean, catalogJson: boolean, refreshCatalog: boolean, allModels: boolean, planId?: string, catalogMode: boolean }} 运行选项。
 * @throws {QuotaError} 未知参数或参数缺值时抛 `USAGE`。
 */
function parseArgs(argv) {
  const options = {
    json: false,
    ascii: false,
    color: process.stdout.isTTY === true,
    apiBase: DEFAULT_API_BASE,
    timeoutMs: resolveTimeoutMs(),
    models: false,
    catalogJson: false,
    refreshCatalog: false,
    allModels: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--ascii') options.ascii = true;
    else if (arg === '--color') options.color = true;
    else if (arg === '--no-color') options.color = false;
    else if (arg === '--models') options.models = true;
    else if (arg === '--catalog-json') options.catalogJson = true;
    else if (arg === '--refresh-catalog') options.refreshCatalog = true;
    else if (arg === '--all-models') options.allModels = true;
    else if (arg === '--plan') options.planId = requireValue(argv, (index += 1), '--plan');
    else if (arg === '--watch') {
      const next = argv[index + 1];
      options.watchSeconds = next === undefined || next.startsWith('--') ? 60 : Number(next);
      if (next !== undefined && !next.startsWith('--')) index += 1;
      if (!Number.isFinite(options.watchSeconds) || options.watchSeconds <= 0) {
        throw new QuotaError('USAGE', '--watch 需要一个正数秒数，例如 --watch 60');
      }
    } else if (arg === '--base') {
      options.apiBase = requireValue(argv, (index += 1), '--base');
    } else if (arg === '--timeout') {
      const value = Number(requireValue(argv, (index += 1), '--timeout'));
      if (!Number.isFinite(value) || value <= 0) throw new QuotaError('USAGE', '--timeout 需要一个正数毫秒值');
      options.timeoutMs = value;
    } else if (arg === '--key') {
      options.apiKey = requireValue(argv, (index += 1), '--key');
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new QuotaError('USAGE', `未知参数 ${arg}（--help 看用法）`);
    }
  }

  // 目录参数里随便给一个就进目录模式：`--plan X` 单独用等于 `--models --plan X`。
  options.catalogMode = options.models || options.catalogJson || options.refreshCatalog || options.allModels || options.planId !== undefined;
  if (options.catalogMode && options.json) {
    throw new QuotaError('USAGE', '--json 不能与目录参数同用：--catalog-json 输出的已经是 JSON');
  }
  if (options.catalogMode && options.watchSeconds !== undefined) {
    // 目录核对的频率由用户决定，绝不轮询：--refresh-catalog 每次运行只核对一次。
    throw new QuotaError('USAGE', '--watch 不能与 --models/--catalog-json/--refresh-catalog 同用（要持续看请自己重复运行）');
  }
  if (options.planId !== undefined && !Object.hasOwn(PLAN_DOC_URLS, options.planId)) {
    throw new QuotaError('USAGE', `未知套餐 id ${options.planId}（已知：${Object.keys(PLAN_DOC_URLS).join('、')}）`);
  }
  return options;
}

/** 取一个需要值的参数，缺失即报错。 */
function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new QuotaError('USAGE', `${flag} 缺少取值`);
  return value;
}

function printUsage() {
  process.stdout.write(
    [
      '用法: node cli.mjs [选项]',
      '',
      '  --json           输出归一化 JSON，不渲染',
      '  --watch [秒]     持续刷新，默认每 60 秒',
      '  --ascii          进度条只用 ASCII 字符',
      '  --color / --no-color  强制开关 ANSI 颜色',
      '  --base <url>     API 基地址，默认 ' + DEFAULT_API_BASE,
      '  --timeout <ms>   单端点超时，默认 ' + resolveTimeoutMs() + '（可用 ' + TIMEOUT_ENV_NAME + ' 覆盖）',
      '  --key <key>      显式 API key（优先级最高，会留在 shell 历史里）',
      '',
      '  --models         打印当前套餐的「模型 → 5 小时/每周/每月次数」表（优先本地，不联网）',
      '  --catalog-json   输出目录视图 JSON（脚本用，stdout 只有 JSON；诊断走 stderr）',
      '  --refresh-catalog 先核对官方目录再打印（可与 --models/--catalog-json 组合；单独用等于刷新后打印模型表）',
      '  --all-models     连「官方没给次数」的模型也列出',
      '  --plan <planId>  显式指定套餐（拿不到实时报告时用；也给目录命令用，单独用等于 --models）',
      '',
      '目录只读缓存与内置基线，只有 --refresh-catalog 会联网核对一次；套餐 id 取不到时用 --plan 指定。',
      '',
    ].join('\n'),
  );
}

/** 两位小数金额；缺字段显示 `—`。 */
function money(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '—';
}

/** token 数以 K/M/B 缩写。 */
function tokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

/** 本地时间，`今天 / 明天 / MM-DD HH:mm`。 */
function when(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined;
  const target = new Date(timestamp);
  const now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const time = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  if (sameDay(target, now)) return `今天 ${time}`;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (sameDay(target, tomorrow)) return `明天 ${time}`;
  return `${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')} ${time}`;
}

/** 剩余时长，粗到"天/小时/分"即可。 */
function countdown(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined;
  const deltaMs = timestamp - Date.now();
  if (deltaMs <= 0) return '已到期';
  const minutes = Math.floor(deltaMs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const restMinutes = minutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时后`;
  if (hours > 0) return `${hours} 小时 ${restMinutes} 分后`;
  return `${restMinutes} 分后`;
}

/** 终端显示宽度：CJK 与全角字符占两列，`padEnd` 按字符数算会错位。 */
function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 按显示宽度右侧补空格，保证各窗口行左边对齐。 */
function padLabel(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** 进度条。`ratio` 为 0–100 的百分比。 */function bar(percent, useAscii, color) {
  const filled = percent === undefined ? 0 : Math.round((Math.max(0, Math.min(100, percent)) / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const full = useAscii ? '#' : '█';
  const rest = useAscii ? '-' : '░';
  const level = LEVELS.find((entry) => (percent ?? 0) < entry.limit) ?? LEVELS[LEVELS.length - 1];
  const body = full.repeat(filled) + rest.repeat(empty);
  return color ? `${level.color}${body}${RESET}` : body;
}

/**
 * 一行额度窗口。
 *
 * 金额只给月度：5 小时/每周是"能不能用"的闸门而非预算，摆出金额没有可执行性，
 * 与卡片保持同一取舍（完整数字仍可从 `--json` 取）。
 */
function windowLine(label, window, options, withMoney = false) {
  const heading = padLabel(label, LABEL_WIDTH);
  if (window === undefined) return [`${heading} 该账号未上报此窗口`];
  // 跨计费周期的读数：两个端点描述的不是同一个时刻，拒绝给出任何数字。
  if (withMoney && window.capSuspect === true) {
    const reset = countdown(window.resetAt);
    return [`${heading} ${' '.repeat(BAR_WIDTH + 2)}本次读数跨了计费周期${reset === undefined ? '' : `，${when(window.resetAt)} 重置（${reset}）`}`];
  }
  const percent = window.percent;
  const span = withMoney ? ` · ${money(window.used)} / ${money(window.cap)}` : '';
  const head = `${heading} ${bar(percent, options.ascii, options.color)} ${percent === undefined ? '—' : `${percent.toFixed(1)}%`}${span}`;
  const reset = countdown(window.resetAt);
  const detail = [
    // Clamped at zero like the card: an overdrawn allowance says "nothing
    // left", not a negative amount that looks like a rendering bug.
    withMoney ? `剩余 ${money(Math.max(0, window.cap - window.used))}` : undefined,
    reset === undefined ? undefined : `${when(window.resetAt)} 重置（${reset}）`,
    window.exceeded ? '已超限' : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
  // A blank line after each window: `█` and `░` fill the full line box in most
  // monospace fonts, so a bar sitting directly under a line of text reads as if
  // the two had merged — which is exactly how this looked in the README.
  return [head, `${' '.repeat(LABEL_WIDTH)} ${options.color ? DIM : ''}${detail}${options.color ? RESET : ''}`, ''];
}

/** 渲染完整报告。 */
function render(report, options) {
  const lines = [];
  const title = report.plan === undefined ? 'Command Code' : `Command Code · ${report.plan.name}（${report.plan.planId}）`;
  const who = report.account?.userName ?? report.account?.name ?? '';
  // No right-aligned columns and no rule lines: both depend on character-cell
  // widths, which differ between a terminal and a browser's code font — the
  // README's own rendering of this output is a case in point, where a rule of 72
  // Latin cells came out visibly shorter than a line containing CJK. Every line
  // here stands on its own instead.
  lines.push(options.color ? `${BOLD}${title}${RESET}${who === '' ? '' : ` · ${who}`}` : `${title}${who === '' ? '' : ` · ${who}`}`);
  if (report.credentialSource !== undefined) {
    lines.push(`${options.color ? DIM : ''}key: ${report.credentialSource}${options.color ? RESET : ''}`);
  }
  lines.push('');

  // The blank line each window ends with is dropped from the last group so the
  // summary follows the monthly block instead of floating away from it.
  const groups = [
    windowLine('5 小时', report.fiveHour, options),
    windowLine('每周', report.weekly, options),
    windowLine('月度额度', { ...report.monthly, resetAt: report.plan === undefined ? undefined : Date.parse(report.plan.currentPeriodEnd ?? '') }, options, true),
  ];
  groups.forEach((group, index) => {
    const last = index === groups.length - 1;
    lines.push(...(last ? group.filter((_, lineIndex) => lineIndex < group.length - 1) : group));
  });

  const totals = report.totals;
  lines.push(
    `本周期  ${totals.requests === undefined ? '—' : totals.requests.toLocaleString('en-US')} 请求 · 成功率 ${totals.successRate === undefined ? '—' : `${totals.successRate}%`} · in ${tokens(totals.tokensIn)} / out ${tokens(totals.tokensOut)} tokens`,
  );
  if (report.monthly.freeCredits || report.monthly.purchasedCredits) {
    lines.push(`额外额度  赠送 ${money(report.monthly.freeCredits)} · 已购 ${money(report.monthly.purchasedCredits)}（不受窗口限制）`);
  }
  if (report.failures.length > 0) {
    lines.push(`降级     以下端点失败：${report.failures.join('; ')}`);
  }
  lines.push(`${options.color ? DIM : ''}更新于 ${new Date(report.fetchedAt).toLocaleString('zh-CN')}${options.color ? RESET : ''}`);
  return lines.join('\n');
}

/* ───────────────────────────── 模型次数目录 ───────────────────────────── */
/*
 * 目录层的规矩和额度报告一样：**先回答本地知道什么，再决定要不要联网**。
 * `--models` 在断网、没凭据、没缓存时应当照样出结果（内置基线就是为此存在的）；
 * 只有 `--refresh-catalog` 才去核对官方，而且每次运行最多核对一次 —— 不轮询。
 */

/**
 * 从宿主最近一次报告的快照里读套餐 id。
 *
 * 纯本地：快照由插件自己写（`$DSH_HOME/dsh-commandcode-quota/last-report.json`）。
 * 有它，断网时也知道该看哪个套餐的表，不必先等一次实时报告。
 *
 * @param {string} file 快照路径。
 * @returns {{ planId: string, fetchedAt?: string }|undefined} 读不出就 undefined（不是错误）。
 */
function readSnapshotPlan(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    // Windows 上的编辑器（记事本一类）会给 UTF-8 文件加 BOM，而 JSON.parse 不认它。
    // 宿主自己写的快照没有 BOM，但手工改过的文件不该因此变成「读不出来」。
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) return undefined;
    const report = parsed.report;
    if (report === null || typeof report !== 'object') return undefined;
    const planId = report.plan?.planId;
    if (typeof planId !== 'string' || planId === '') return undefined;
    return { planId, fetchedAt: typeof report.fetchedAt === 'string' ? report.fetchedAt : undefined };
  } catch {
    // 没有快照、半写、版本不认识：一律当作「不知道套餐」。
    return undefined;
  }
}

/** 把可能带换行的错误说明压成一行：终端里一行说一件事。 */
function oneLine(text) {
  return String(text).replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * 实时报告失败时的一句话说明。
 *
 * 取错误码 + 首行：`NETWORK` 的完整说明会列出四个端点各自的失败原因（几百个字符），
 * 塞进目录表头只会把表挤走；要完整原因，跑一次不带目录参数的 cli.mjs 就有。
 */
function probeNote(error) {
  if (error instanceof QuotaError) {
    const first = oneLine(String(error.message).split('\n')[0]);
    return `实时报告没拿到套餐（[${error.code}] ${first}；完整原因跑一次 node cli.mjs 就有）`;
  }
  return `实时报告没拿到套餐（${oneLine(error instanceof Error ? error.message : error)}）`;
}

/**
 * 决定这次看哪个套餐。
 *
 * 优先级：`--plan` 显式指定 → 本地快照（不联网）→ 实时报告（只在需要时问一次）。
 * `--refresh-catalog` 反正要联网，就用实时报告把套餐刷新一遍，快照过期也不怕。
 * 实时报告失败（没凭据、断网、接口报错）只留一句说明，绝不挡住目录本身。
 *
 * @param {object} options 已解析的运行选项。
 * @returns {Promise<{ planId?: string, source: 'flag'|'snapshot'|'report'|'single-plan'|'none', note?: string, fetchedAt?: string }>} 套餐上下文。
 */
async function resolvePlanContext(options) {
  if (options.planId !== undefined) return { planId: options.planId, source: 'flag' };
  const snapshot = readSnapshotPlan(quotaSnapshotPath());
  if (!options.refreshCatalog && snapshot !== undefined) {
    return { planId: snapshot.planId, source: 'snapshot', fetchedAt: snapshot.fetchedAt };
  }
  // 只有真的可能拿到 key 才值得问一次接口；否则连 MISSING_CREDENTIAL 都拿不到 planId。
  const mayHaveKey = options.apiKey !== undefined || credentialFingerprint() !== undefined;
  if (mayHaveKey) {
    try {
      const report = await fetchQuotaReport({ apiKey: options.apiKey, apiBase: options.apiBase, timeoutMs: options.timeoutMs });
      const planId = report.plan?.planId;
      if (typeof planId === 'string' && planId !== '') return { planId, source: 'report' };
      return snapshot === undefined
        ? { planId: undefined, source: 'none', note: '实时报告里没有套餐信息' }
        : { planId: snapshot.planId, source: 'snapshot', fetchedAt: snapshot.fetchedAt, note: '实时报告里没有套餐信息' };
    } catch (error) {
      const note = probeNote(error);
      return snapshot === undefined
        ? { planId: undefined, source: 'none', note }
        : { planId: snapshot.planId, source: 'snapshot', fetchedAt: snapshot.fetchedAt, note };
    }
  }
  if (snapshot !== undefined) return { planId: snapshot.planId, source: 'snapshot', fetchedAt: snapshot.fetchedAt };
  return { planId: undefined, source: 'none' };
}

/** 本地已有的目录对象：缓存优先，其次内置基线（与 {@link resolveCatalogView} 同一顺序）。 */
function readLocalCatalog() {
  return readCatalogCache() ?? readCatalogSeed();
}

/**
 * 核对一次官方。
 *
 * syncCatalog 自己按页记账（某个页面抓不到只进 failures）；这里再兜一层，
 * 让「核对失败」永远只是降级信息，而不是把整个命令带走。
 *
 * @param {string|undefined} planId 当前套餐。
 * @returns {Promise<{ changed: boolean, failures: object[] }>} 核对结果。
 */
async function refreshCatalogOnce(planId) {
  try {
    const { changed, failures } = await syncCatalog({ planId });
    return { changed, failures };
  } catch (error) {
    return { changed: false, failures: [{ code: 'CATALOG_SYNC', message: oneLine(error instanceof Error ? error.message : error) }] };
  }
}

/** ISO 时间 → `今天 12:03（3 小时前）`；缺字段显示 `—`。 */
function stamp(iso) {
  if (typeof iso !== 'string' || iso === '') return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  const age = minutes < 1
    ? '刚刚'
    : minutes < 60
      ? `${minutes} 分钟前`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} 小时前`
        : `${Math.floor(minutes / 1440)} 天前`;
  return `${when(ms)}（${age}）`;
}

/** 0.2 → `20%`。 */
function percent(fraction) {
  return typeof fraction === 'number' && Number.isFinite(fraction) ? `${Number((fraction * 100).toPrecision(3))}%` : '—';
}

/** 套餐上下文那一行的说明。 */
function contextText(context) {
  if (context.source === 'flag') return `--plan 显式指定（${context.planId}）`;
  if (context.source === 'single-plan') return `拿不到套餐 id，但目录里只有 ${context.planId} 一个套餐，按它展示`;
  if (context.source === 'snapshot') return `来自宿主最近一次报告的快照（${stamp(context.fetchedAt)}）`;
  if (context.source === 'report') return '来自刚刚的实时报告';
  return '没有（拿不到实时报告的套餐 id，也没给 --plan）';
}

/**
 * 表头：数据从哪来、什么时候核对的、数字按什么口径算的。
 *
 * 这些必须在数字之前 —— 读者要能判断「这些次数有多可信」。
 *
 * @param {object} view 目录视图。
 * @param {object|undefined} catalog 本地目录对象（判「该不该再核对」用）。
 * @param {object} context 套餐上下文。
 * @param {object} options 运行选项。
 * @returns {string[]} 行。
 */
function catalogHeadLines(view, catalog, context, options) {
  const lines = [];
  const title = view.planName === undefined
    ? 'Command Code 模型次数目录'
    : `Command Code 模型次数目录 · ${view.planName}（${view.planId}）`;
  lines.push(options.color ? `${BOLD}${title}${RESET}` : title);
  lines.push(`套餐上下文  ${contextText(context)}${context.note === undefined ? '' : ` · ${context.note}`}`);
  // neverSynced 表示连内置基线都没有：那时说「内置基线」会把「什么都没有」说成有数据。
  const originText = view.neverSynced === true
    ? '没有：本机没有缓存，也没有内置基线'
    : view.origin === 'bundled'
      ? '内置基线（随包发布，尚未与官方核对）'
      : '本机目录缓存';
  lines.push(`数据来源  ${originText} · origin=${view.origin} · verified=${String(view.verified)}`);
  lines.push(`官方更新  ${stamp(view.updatedAt)}`);
  lines.push(`本地核对  ${stamp(view.checkedAt)} · stale=${String(view.stale)}${view.fetchMode === null || view.fetchMode === undefined ? '' : ` · fetchMode=${view.fetchMode}`}`);
  if (view.fetchMode === 'hash') {
    // 这是核对方式，不是故障：本机 HEAD 被网关挡住时宿主改用整篇摘要比对，效果一样、多下一次正文。
    lines.push('核对方式  本机 HEAD 探针不可用，这次核对改用整篇摘要比对（多下载一次正文，不是错误）');
  }
  if (view.docUrl !== null && view.docUrl !== undefined) lines.push(`官方页面  ${view.docUrl}`);
  if (view.inferredFrom !== undefined) lines.push(`推断说明  官方没有该套餐的专页，按 ${view.inferredFrom} 的表展示`);
  if (view.basis !== null && view.basis !== undefined) {
    const windows = view.windows === null || view.windows === undefined
      ? ''
      : `；窗口系数 5 小时 ${percent(view.windows.fiveHourFraction)} · 每周 ${percent(view.windows.weeklyFraction)}`;
    lines.push(`估算口径  每次请求按 输入 ${formatCount(view.basis.inputTokens)} / 输出 ${formatCount(view.basis.outputTokens)} / 缓存读 ${formatCount(view.basis.cacheReadTokens)} tokens 计${windows}`);
  }
  if (view.planLevel !== null && view.planLevel !== undefined) {
    const credits = view.planLevel.credits === undefined ? '' : `（${view.planLevel.credits}）`;
    lines.push(`套餐级概览  官方定价页写的是 ${view.planLevel.requestsText ?? '—'}${credits} · 套餐级口径，与单模型次数不是一套算法`);
  }
  for (const warning of view.warnings) {
    if (warning === 'catalog-bundled-baseline') continue; // 「数据来源」那行已经说了
    lines.push(`注意  ${warning}`);
  }
  if (view.failures.length > 0) {
    lines.push('降级  以下页面没能核对，数字可能不是最新的：');
    for (const failure of view.failures) {
      const url = failure.url === undefined ? '' : ` ${failure.url}`;
      const detail = failure.message === undefined ? '' : `：${oneLine(failure.message)}`;
      lines.push(`  ${failure.code}${url}${detail}`);
    }
  }
  if (!options.refreshCatalog && needsRevalidate({ catalog })) {
    lines.push('提示  本地目录已超过核对间隔，`--refresh-catalog` 可以核对一次官方（频率由你决定，不轮询）。');
  }
  return lines;
}

/**
 * 默认只列「你配置的模型」。
 *
 * CLI 没有 DSH 的模型配置上下文（`configured` 全为 false），这时退化为列出该套餐
 * 全部「官方给了次数」的模型，并在表头说明 —— 一张空表比多列几行更让人困惑。
 * `--all-models` 再把「官方没给次数」的可用性条目也带上。
 *
 * @param {object} view 目录视图。
 * @param {object} options 运行选项。
 * @returns {object[]} 要打印的模型。
 */
function selectModels(view, options) {
  const configured = view.models.filter((model) => model.configured);
  if (options.allModels) return view.models;
  if (configured.length > 0) return configured;
  return view.models.filter((model) => model.estimated);
}

/** 选择口径那一行，解释为什么表里是这些模型。 */
function selectionNote(view, options) {
  const configured = view.models.filter((model) => model.configured);
  if (configured.length > 0) {
    return options.allModels
      ? `说明  你配置了 ${configured.length} 个模型（已置顶），--all-models 连同该套餐其余模型一起列出。`
      : `说明  只列你配置的 ${configured.length} 个模型（已置顶）；加 --all-models 看该套餐全部模型。`;
  }
  return options.allModels
    ? '说明  这里没有 DSH 的模型配置上下文（configured 全为 false），--all-models 列出该套餐全部模型，含官方没给次数的条目（显示 —）。'
    : '说明  这里没有 DSH 的模型配置上下文（configured 全为 false），下面列出该套餐所有「官方给了次数」的模型；加 --all-models 连官方没给次数的也列。';
}

/**
 * 一个模型一行，行内自带标签。
 *
 * 不做依赖字符宽度的右对齐多列，也不用满行高的块字符：终端和中日韩字体下的
 * 对齐结果是不可控的，而每行自洽的输出在任何地方都读得通。
 *
 * @param {object[]} models 视图里的模型。
 * @returns {string[]} 行。
 */
function modelLines(models) {
  const lines = [];
  for (const model of models) {
    const id = model.modelId === undefined ? '' : `  [${model.modelId}]`;
    // 先看 free：免费模型单价为 0 → 次数无限，而 JSON 里存不下 Infinity，落盘后
    // `monthly`/`fiveHour`/`week` 是 null。只按数字判空会把「免费」显示成「—」。
    if (model.free === true) {
      lines.push(`  ${model.name}${id}  免费模型：不限次数（Free）`);
      continue;
    }
    const missing = (value) => value === undefined || value === null;
    if (missing(model.fiveHour) && missing(model.week) && missing(model.monthly)) {
      lines.push(`  ${model.name}${id}  5 小时 — · 每周 — · 每月 —（官方没给这个模型的次数，只确认了它在本套餐可用）`);
      continue;
    }
    lines.push(`  ${model.name}${id}  5 小时 ${formatCount(model.fiveHour)} 次 · 每周 ${formatCount(model.week)} 次 · 每月 ${formatCount(model.monthly)} 次`);
    // 峰谷价只在生效后才由 catalog 层给出来；有就说明一句，不塞进主行。
    if (model.peak !== undefined && model.peak !== null) {
      lines.push(`    峰时口径  5 小时 ${formatCount(model.peak.fiveHour)} 次 · 每周 ${formatCount(model.peak.week)} 次 · 每月 ${formatCount(model.peak.monthly)} 次`);
    }
  }
  return lines;
}

/** 找套餐级概览里对应的那一行（有的套餐名在概览表里不存在，例如 Ultra）。 */
function planLevelOf(catalog, planName) {
  if (planName === undefined) return undefined;
  return (catalog?.planLevel?.rows ?? []).find((row) => row.label === planName || row.label.startsWith(planName));
}

/** 没有套餐上下文时：列出本地目录收录了哪些套餐，而不是假装知道用户是哪一个。 */
function planOverviewLines(plans, catalog) {
  const lines = [`本地目录收录了 ${plans.length} 个套餐；没有套餐上下文时先给概览，加 --plan <planId> 看某个套餐的完整模型表：`];
  for (const [planId, entry] of plans) {
    const level = planLevelOf(catalog, entry.planName);
    lines.push(`  ${planId}  ${entry.planName ?? ''}  官方给了次数 ${entry.publishedModels ?? 0} 个模型 · 本套餐可用 ${entry.availableModels ?? 0} 个${level === undefined ? '' : ` · 官方概览 ${level.usageText ?? '—'}`}`);
  }
  return lines;
}

/** 同一张官方表可能挂在两个 planId 下（go 与 go-v1）：全量列表里按「表」去重。 */
function distinctPlans(plans) {
  const seen = new Set();
  const out = [];
  for (const [planId, entry] of plans) {
    const signature = `${entry.planName ?? planId}|${entry.publishedModels ?? 0}|${entry.availableModels ?? 0}|${JSON.stringify(entry.fractions ?? null)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push([planId, entry]);
  }
  return out;
}

/** `--all-models` 却没有套餐上下文：把目录里每张表都列出来。 */
function allPlanTables(plans, options) {
  const lines = [''];
  for (const [planId, entry] of distinctPlans(plans)) {
    const planView = resolveCatalogView({ planId, configuredModels: [] });
    lines.push(`套餐 ${planId} · ${entry.planName ?? ''}  官方给了次数 ${entry.publishedModels ?? 0} 个 · 本套餐可用 ${entry.availableModels ?? 0} 个`);
    lines.push(...modelLines(selectModels(planView, options)), '');
  }
  return lines;
}

/**
 * 表里没有模型时的正文：把「为什么没有」说清楚，并给出下一步。
 *
 * @returns {string[]} 行。
 */
function emptyBodyLines(catalog, context, options, plans) {
  const lines = [];
  const planId = context.planId;
  if (planId !== undefined && PLAN_DOC_URLS[planId] === undefined) {
    lines.push(`官方没有发布 ${planId} 的模型次数表（官方只发布 Go / GOAT / Pro / Max 四张 per-model 表），所以这里没有次数可列。`);
    return lines;
  }
  if (planId !== undefined) {
    lines.push(`本地这份目录里没有 ${planId} 的条目，拿不到它的表；加 --refresh-catalog 可以核对一次官方。`);
  }
  if (plans.length === 0) {
    const rows = catalog?.planLevel?.rows ?? [];
    if (rows.length > 0) {
      lines.push('本地目录里没有 per-model 表，只有官方定价页的套餐级概览：');
      for (const row of rows) lines.push(`  ${row.label}  ${row.credits ?? '—'}  ${row.usageText ?? '—'}`);
      lines.push('加 --plan <planId>（或配好凭据，让实时报告给出套餐）就能抓对应套餐的模型表。');
    } else {
      lines.push('本地目录里没有任何套餐的模型表。');
    }
    return lines;
  }
  if (planId === undefined) {
    lines.push(...planOverviewLines(plans, catalog));
    if (options.allModels) {
      lines.push(...allPlanTables(plans, options));
    } else {
      lines.push('提示  加 --plan <planId> 看某个套餐的完整表；加 --all-models 连官方没给次数的模型一起列出（也会把每张表都打出来）。');
    }
  }
  return lines;
}

/**
 * 目录模式的人类可读输出。
 *
 * @param {object} view 目录视图。
 * @param {object|undefined} catalog 本地目录对象。
 * @param {object} context 套餐上下文。
 * @param {object} options 运行选项。
 * @param {{changed: boolean, failures: object[]}|undefined} refresh 本次核对结果（没核对就是 undefined）。
 * @returns {string} 完整输出。
 */
function renderCatalog(view, catalog, context, options, refresh) {
  const head = [];
  if (refresh !== undefined) {
    head.push(`已核对官方  changed=${String(refresh.changed)} · 页面失败 ${refresh.failures.length} 个`);
  }
  head.push(...catalogHeadLines(view, catalog, context, options));

  const plans = Object.entries(catalog?.plans ?? {});
  const models = selectModels(view, options);
  const body = [];
  if (models.length > 0) {
    body.push(selectionNote(view, options), '', ...modelLines(models));
    const hidden = view.models.length - models.length;
    body.push('', `共 ${models.length} 个模型${hidden > 0 ? `（另有 ${hidden} 个没有列出：加 --all-models 看全部）` : ''}`);
  } else {
    body.push(...emptyBodyLines(catalog, context, options, plans));
  }
  // 每段自带结尾空行，别让最后多出一行空白。
  const lines = [...head, '', ...body];
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * 目录模式：`--models` / `--catalog-json` / `--refresh-catalog`（可任意组合）。
 *
 * 顺序刻意是「先本地、后网络」：本地有缓存或内置基线就先回答，只有 --refresh-catalog
 * 才去核对官方；实时报告只用来回答「现在是哪个套餐」，它失败不该挡住目录。
 *
 * @param {object} options 运行选项。
 * @returns {Promise<boolean>} 是否至少有一份目录数据（决定退出码：没有数据才非零）。
 */
async function runCatalog(options) {
  let context = await resolvePlanContext(options);
  let catalog = readLocalCatalog();
  let refresh;
  if (options.refreshCatalog) {
    refresh = await refreshCatalogOnce(context.planId);
    // syncCatalog 已经把新目录原子写进缓存，重新读一次就是最新的一份。
    catalog = readLocalCatalog();
  }
  let view = resolveCatalogView({ planId: context.planId, configuredModels: [] });
  // 不知道套餐、目录里又只有一张表时按它展示并在表头写明：只有一种可能时，
  // 还要用户先猜对 id 才看得到数字，没有意义。
  if (view.models.length === 0 && context.planId === undefined) {
    const only = Object.keys(catalog?.plans ?? {});
    if (only.length === 1) {
      view = resolveCatalogView({ planId: only[0], configuredModels: [] });
      context = { ...context, planId: only[0], source: 'single-plan' };
    }
  }

  const hasData = catalog !== undefined;
  if (!hasData) {
    process.stderr.write(
      '[NO_CATALOG_DATA] 本机既没有目录缓存（$DSH_HOME/dsh-commandcode-quota/catalog.json），也没有随包内置的 catalog.seed.json：没有任何模型数据。加 --refresh-catalog 可以联网核对一次官方。\n',
    );
  }

  if (options.catalogJson) {
    // stdout 只有 JSON，诊断一律走 stderr。
    if (refresh !== undefined) {
      process.stderr.write(`已核对官方  changed=${String(refresh.changed)} · 页面失败 ${refresh.failures.length} 个\n`);
    }
    // 视图本身原样输出；只额外附上两个脚本需要的上下文，不改视图的字段。
    const payload = { ...view, planIdSource: context.source, planIds: Object.keys(catalog?.plans ?? {}) };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return hasData;
  }
  process.stdout.write(`${renderCatalog(view, catalog, context, options, refresh)}\n`);
  return hasData;
}

/** 跑一次并渲染。 */
async function runOnce(options) {
  const report = await fetchQuotaReport({
    apiKey: options.apiKey,
    apiBase: options.apiBase,
    timeoutMs: options.timeoutMs,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${render(report, options)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.catalogMode) {
    // 目录模式不因「没有凭据」失败：内置基线与缓存就是给这种情况准备的。
    process.exitCode = (await runCatalog(options)) ? 0 : 1;
    return;
  }
  if (options.watchSeconds === undefined) {
    await runOnce(options);
    return;
  }
  for (;;) {
    if (options.color) process.stdout.write('\u001b[2J\u001b[H');
    try {
      await runOnce(options);
    } catch (error) {
      process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.watchSeconds * 1000));
  }
}

main().catch((error) => {
  if (error instanceof QuotaError) {
    process.stderr.write(`[${error.code}] ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
