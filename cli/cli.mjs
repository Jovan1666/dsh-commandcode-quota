#!/usr/bin/env node
/**
 * Command Code 额度命令行：把 {@link module:commandcode-quota/lib} 的报告渲染成
 * 人类可读的进度条，或原样输出 JSON。
 *
 * 只读，不改动任何状态；不依赖 DSH 运行时，因此随时可跑，不需要重启 GUI。
 *
 * @example
 * node cli.mjs             # 渲染一次
 * node cli.mjs --json      # 给脚本消费
 * node cli.mjs --watch 60  # 每 60 秒刷新
 */

import { DEFAULT_API_BASE, DEFAULT_TIMEOUT_MS, QuotaError, fetchQuotaReport } from '../quota.mjs';

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
 * @returns {{ json: boolean, watchSeconds?: number, ascii: boolean, color: boolean, apiBase: string, timeoutMs: number, apiKey?: string }} 运行选项。
 * @throws {QuotaError} 未知参数或参数缺值时抛 `USAGE`。
 */
function parseArgs(argv) {
  const options = {
    json: false,
    ascii: false,
    color: process.stdout.isTTY === true,
    apiBase: DEFAULT_API_BASE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--ascii') options.ascii = true;
    else if (arg === '--color') options.color = true;
    else if (arg === '--no-color') options.color = false;
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
      '  --timeout <ms>   单端点超时，默认 ' + DEFAULT_TIMEOUT_MS,
      '  --key <key>      显式 API key（优先级最高，会留在 shell 历史里）',
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
