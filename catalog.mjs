/**
 * Command Code 目录（catalog）：某个套餐下，每个模型「全部用这个模型大概能调用多少次」。
 *
 * 官方从不直接发布次数。它发布三样东西，次数是**在浏览器里算出来的**：
 *
 *   1. 该模型在这个套餐下的月度额度（美元）—— 套餐页 RSC 里 `rows[].budgetUsd`；
 *   2. 单价（每 1M token 的输入/输出/缓存读）—— 同一条 row 的 `rates`；
 *   3. 典型请求形状（默认 800 输入 / 200 输出 / 50,000 缓存读）—— 同一条 row 的 `shape`。
 *
 * 站点自己的公式（从它的客户端 JS 还原，并用它渲染出的表格逐行校验过）：
 *
 *   每次成本 = 输入/1e6×inputCost + 输出/1e6×outputCost + 缓存读/1e6×cacheReadCost
 *   月次数   = budgetUsd ÷ 每次成本          （成本为 0 → 无限次，站点显示 "Free"）
 *   5 小时   = 月次数 × fiveHourFraction
 *   每周     = 月次数 × weeklyFraction
 *
 * 本模块复刻这条公式，**不猜**：`tests/catalog.test.mjs` 用官方页面渲染出来的
 * 数字（30,800 / 76,900 / 154,000 …）逐行断言，公式一旦漂移就会红。
 *
 * 数据源与抓取：
 *   - 首选 `GET <套餐页> + RSC: 1` → `text/x-component`，约 199 KB（gzip 约 37 KB），
 *     是同一页 HTML 里那份数据的**结构化形式**，比抓 762 KB 的 HTML 省钱且不必解 HTML。
 *   - 变更检测不靠 304：官方（Cloudflare + Next 预渲染）**忽略了所有 If-* 条件头**，
 *     实测把服务器刚给的 ETag 原样回传仍回 200 全量。可行的是 `HEAD + RSC: 1`：
 *     **0 字节**拿到该页强 ETag，本地字符串比一比就知道变没变；变了才 GET。
 *   - 频率由 {@link CATALOG_TTL_MS}（默认一天）和用户手动触发决定，绝不轮询。
 *
 * 零依赖：只用 Node 18+ 的全局 `fetch`、`node:crypto`、`node:fs`。
 *
 * @module commandcode-quota/catalog
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 缓存文件的种类标记：与 last-report.json 互不误认。 */
export const CATALOG_KIND = 'commandcode-catalog';

/** 文件格式版本；读不认识就当没有缓存。 */
export const CATALOG_VERSION = 1;

/**
 * 解析与计算口径版本；变了就强制重解析（不看哈希），并把旧缓存/旧 seed 直接判为过期。
 *
 * v2：加入「按官方 provider 默认形状推算」「免费模型」「Go 两代按 planId 取窗口系数」
 * 三条口径。旧缓存里的 coverage 与模型行都缺这些信息，必须重算而不是接着用。
 */
export const CATALOG_SCHEMA = 2;

/** 距上次**核对**超过这么久，才值得再问一次官方。 */
export const CATALOG_TTL_MS = 24 * 3_600_000;

/** 网络失败后的最小重试间隔：失败不是「一天一次」的借口，但也不能变成轮询。 */
export const CATALOG_MIN_RETRY_MS = 6 * 3_600_000;

/** 覆盖 {@link CATALOG_TTL_MS} 的环境变量名；与密钥兜底扫描同名冲突，见 quota.mjs 的排除表。 */
export const CATALOG_TTL_ENV_NAME = 'COMMANDCODE_CATALOG_TTL_MS';

/** 单次请求超时；官方整页 200–500 KB，正常半秒内返回。 */
export const CATALOG_TIMEOUT_MS = 20_000;

/** 套餐级概览（`~75K requests`）所在页。 */
export const PRICING_DOC_URL = 'https://commandcode.ai/docs/resources/pricing-limits';

/**
 * planId → 套餐页。官方只发布了 Go / GOAT / Pro / Max 四张 per-model 表。
 *
 * `individual-ultra` 官方**没有**专页，其模型集与 Max 完全一致（87/89 实测），
 * 因此按 Max 展示并在视图里带 `inferred: true`，让界面必须写出「按 Max 推断」。
 * `individual-provider` 是按量计费，页面没有次数表；`teams-pro` 连页面都没有，
 * 两者只能给套餐级/可用性信息 —— 目录如实留空，不编数字。
 */
export const PLAN_DOC_URLS = Object.freeze({
  'individual-go': { url: 'https://commandcode.ai/docs/plans/go', name: 'Go' },
  'individual-go-v1': { url: 'https://commandcode.ai/docs/plans/go', name: 'Go' },
  'individual-goat': { url: 'https://commandcode.ai/docs/plans/goat', name: 'GOAT' },
  'individual-pro': { url: 'https://commandcode.ai/docs/plans/pro', name: 'Pro' },
  'individual-pro-v1': { url: 'https://commandcode.ai/docs/plans/pro', name: 'Pro' },
  'individual-max': { url: 'https://commandcode.ai/docs/plans/max', name: 'Max' },
  'individual-ultra': { url: 'https://commandcode.ai/docs/plans/max', name: 'Ultra', inferred: 'Max' },
  'individual-provider': undefined,
  'teams-pro': undefined,
});

/**
 * Go 两代的窗口系数，按**完整 planId** 取，不能按短 tier（`go`）取。
 *
 * Go 页 props 给的是 $3/$6 那一代（0.3/0.6），而官方用量页与定价页对新版
 * `individual-go` 写的是 $2/$5（0.2/0.5）。短 tier 是**多对一**的
 * （`go` ← `individual-go` + `individual-go-v1`），盲信页面 props 会让新版 Go
 * 用户的 5 小时/每周次数**高估 50%**。
 */
const GO_FRACTIONS = Object.freeze({
  'individual-go': { fiveHourFraction: 0.2, weeklyFraction: 0.5 },
  'individual-go-v1': { fiveHourFraction: 0.3, weeklyFraction: 0.6 },
});

/**
 * planId → 定价页概览表里的行标签。
 *
 * 概览表（Plan / Price / Credits / Included LLM Usage / Models）是**套餐级**口径，
 * 与单模型次数不是一套算法，两者不可互推，界面上必须分层显示。
 * Max 在表里分 10× 与 20× 两行：`individual-max` 的内含额度 $150 对应 10×，
 * Ultra 的 $300 对应 20×。
 */
export const PLAN_LEVEL_LABELS = Object.freeze({
  'individual-go': 'Go',
  'individual-go-v1': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-pro-v1': 'Pro',
  'individual-max': 'Max 10×',
  'individual-ultra': 'Max 20×',
  'individual-provider': 'Provider',
  'teams-pro': 'Team Pro',
});

/** 一次 GET 最多收多少字节；官方页面 200–800 KB，留足余量又不给内存挖坑。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 抓取时固定发送的请求头。站点声明 `Vary` 里含 rsc/router 相关头，多一个就可能换一份内容。 */
export const CATALOG_REQUEST_HEADERS = Object.freeze({ RSC: '1' });

/** 目录缓存文件；与额度快照同目录，插件自己的家。 */
export function catalogCachePath(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const dshHome = options.dshHome ?? env.DSH_HOME ?? path.join(home, '.dsh');
  return path.join(dshHome, 'dsh-commandcode-quota', 'catalog.json');
}

/** 随包发布的内置基线；首次运行、离线、被墙时先看它。 */
export function catalogSeedPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'catalog.seed.json');
}

/** 解析这次该等多久才重新核对官方：显式 → 环境变量 → {@link CATALOG_TTL_MS}。 */
export function resolveCatalogTtlMs(options = {}) {
  const explicit = options.ttlMs;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return Math.round(explicit);
  const raw = (options.env ?? process.env)[CATALOG_TTL_ENV_NAME];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw);
    // 1 分钟 – 30 天：更小等于轮询，更大等于永不更新。
    if (Number.isFinite(value) && value >= 60_000 && value <= 30 * 86_400_000) return Math.round(value);
  }
  return CATALOG_TTL_MS;
}

/**
 * 把模型名/id 归一到同一个键，供「你配置的模型」和官方表格对上号。
 *
 * `DeepSeek V4.1 Flash`、`deepseek/deepseek-v4.1-flash`、`DeepSeek V4.1 Flash (latest)`
 * 必须落到同一个键：官方两处用的写法不同，配置里写的又是第三种。
 *
 * @param {unknown} value 模型名或 id。
 * @returns {string|undefined} 归一化后的键。
 */
export function normalizeModelKey(value) {
  if (typeof value !== 'string') return undefined;
  const withoutParens = value.replace(/\([^)]*\)/g, ' ');
  const tail = withoutParens.includes('/') ? withoutParens.slice(withoutParens.lastIndexOf('/') + 1) : withoutParens;
  const key = tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  if (key === '') return undefined;
  return key.replace(/-latest$/, '');
}

/**
 * 把站点自己的数字格式搬过来：`Number(x.toPrecision(3)).toLocaleString('en-US')`。
 *
 * 154000 → `154,000`；2070 → `2,070`；无限大 → `Free`（免费模型单价为 0，
 * 站点的次数就是无限，显示成 "Free" 而不是编一个数）。
 *
 * @param {number|undefined} value 次数。
 * @returns {string} 展示文本。
 */
export function formatCount(value) {
  if (value === undefined || value === null) return '—';
  if (!Number.isFinite(value)) return 'Free';
  if (value <= 0) return '0';
  return Number(value.toPrecision(3)).toLocaleString('en-US');
}

/** 剥掉弱校验前缀，只留可比对的 ETag 字面量。 */
export function stripWeak(etag) {
  if (typeof etag !== 'string') return undefined;
  const trimmed = etag.trim();
  return trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
}

/**
 * 解析 RSC flight 流：每行 `id:JSON`（id 可空），非 JSON 行（模块引用、HL 提示）跳过。
 * @param {string} text `text/x-component` 正文。
 * @returns {Array<{ id: string, value: unknown }>} 解析出来的记录。
 */
export function parseFlightRecords(text) {
  const records = [];
  for (const line of String(text).split('\n')) {
    const match = /^([0-9a-f]*):(.*)$/.exec(line);
    if (match === null) continue;
    const body = match[2];
    if (body === '' || (body[0] !== '[' && body[0] !== '{')) continue;
    try {
      records.push({ id: match[1], value: JSON.parse(body) });
    } catch {
      // 半行/被截断的记录：跳过；整条流都解析不出来时还有 recoverSplitRecords 兜底。
    }
  }
  return records;
}

/**
 * 把 HTML 里的 `self.__next_f.push([1,"…"])` 分块拼回 flight 流。
 *
 * 正常情况下我们靠请求头 `RSC: 1` 直接拿到 `text/x-component`。但代理、CDN 或
 * 中间层可能把这个头吃掉，那时正文是整页 HTML —— 次数表的字段还在里面，只是被
 * 分块转义了。这个兜底让「头被吞」退化成慢一点，而不是什么都读不到。
 *
 * @param {string} html 整页 HTML。
 * @returns {string} 拼接后的 flight 文本（没有分块时返回空串）。
 */
export function decodeNextFlight(html) {
  const chunks = [];
  for (const match of String(html).matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g)) {
    try {
      chunks.push(JSON.parse(match[1]));
    } catch {
      // 坏分块：跳过，剩下的仍可用。
    }
  }
  return chunks.join('');
}

/**
 * 兜底解析：官方把一条记录切成多行时，按行解析会全部落空。
 *
 * 做法是把 `id:` 前缀去掉，再用括号配对（跳过字符串内的括号与转义）从每个 `{`
 * 扫到配平的 `}`，当作一条记录解析。只在主路径一无所获时才跑，正常路径不受影响。
 *
 * @param {string} text RSC 正文。
 * @returns {Array<{ id: string, value: unknown }>}
 */
export function recoverSplitRecords(text) {
  const stripped = String(text).replace(/^[0-9a-f]{1,8}:/gm, '');
  const records = [];
  let index = 0;
  while (index < stripped.length) {
    // 记录可能是对象 `{…}`，也可能是 JSX 数组 `["$","$L47",null,{…}]` —— 两种都要认，
    // 只扫 `{` 会漏掉「组件 props 被切行」这个最常见的形态。
    const nextObject = stripped.indexOf('{', index);
    const nextArray = stripped.indexOf('[', index);
    const start = nextObject === -1 ? nextArray : nextArray === -1 ? nextObject : Math.min(nextObject, nextArray);
    if (start === -1) break;
    const stack = [];
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let cursor = start; cursor < stripped.length; cursor += 1) {
      const char = stripped[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === '}' || char === ']') {
        // 括号不匹配说明这不是一条完整记录：放弃这一段，往后继续找。
        if (stack.pop() !== char) break;
        if (stack.length === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end === -1) break;
    try {
      records.push({ id: '', value: JSON.parse(stripped.slice(start, end + 1)) });
    } catch {
      // 不是完整 JSON：继续往后找下一个起点。
    }
    index = end + 1;
  }
  return records;
}

/**
 * 取出客户端组件的 props。
 *
 * RSC 里组件是 `["$", 类型, key, props]`，我们只认 `props` 位置 —— **绝不按 record id
 * 匹配**（`1c`、`27`、`30` 这些每次部署都会变），只按结构签名找。
 *
 * @param {unknown} value 一条记录的值。
 * @returns {object|undefined} props 对象。
 */
function componentProps(value) {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const props = value[3];
  return props !== null && typeof props === 'object' && !Array.isArray(props) ? props : undefined;
}

/** 递归收集 JSX 子树里的字符串叶子（表格单元格可能是嵌套节点）。 */
function collectText(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    // JSX 元素 `["$", 类型, key, props]`：只取 props.children，别把 "$" 与组件名当文本。
    if (node[0] === '$') return collectText(componentProps(node)?.children);
    return node.map(collectText).join('');
  }
  if (node !== null && typeof node === 'object' && 'children' in node) return collectText(node.children);
  return '';
}

/** 站点用 `$$` 转义 `$`；展示前还原成人看得懂的一个美元符号。 */
function unescapeDollars(text) {
  return String(text ?? '').replace(/\$\$/g, '$').trim();
}

/**
 * 找套餐页里那张 per-model 次数表的数据。
 *
 * 结构签名：某个组件的 props 同时有 `rows` 数组、`fiveHourFraction` 与
 * `weeklyFraction` 两个数字，且 rows[0] 带 `budgetUsd` + `rates` + `shape`。
 *
 * @param {string} text RSC 正文。
 * @returns {{ rows: object[], fiveHourFraction: number, weeklyFraction: number }|undefined}
 */
export function parseEstimates(text) {
  const fromLines = estimatesOf(parseFlightRecords(text));
  if (fromLines !== undefined) return fromLines;
  // `RSC: 1` 头被中间层吞掉时拿到的是整页 HTML：先把 `__next_f` 分块拼回来。
  if (String(text).includes('self.__next_f.push')) {
    const decoded = estimatesOf(parseFlightRecords(decodeNextFlight(text)));
    if (decoded !== undefined) return decoded;
  }
  // 官方把 props 切成多行时按行解析会落空：用括号配对再扫一遍。
  return estimatesOf(recoverSplitRecords(text));
}

/** 在一组记录里按结构签名找次数表。 */
function estimatesOf(records) {
  for (const record of records) {
    const props = componentProps(record.value);
    if (props === undefined) continue;
    const { rows, fiveHourFraction, weeklyFraction } = props;
    if (!Array.isArray(rows) || rows.length === 0) continue;
    if (typeof fiveHourFraction !== 'number' || typeof weeklyFraction !== 'number') continue;
    const shaped = rows.filter((row) => row !== null && typeof row === 'object'
      && typeof row.budgetUsd === 'number' && row.rates !== undefined && row.shape !== undefined);
    if (shaped.length === 0) continue;
    return { rows, fiveHourFraction, weeklyFraction };
  }
  return undefined;
}

/**
 * 找定价页里「模型 id ↔ 名称 ↔ 可用套餐」那张表。
 *
 * 结构签名：props.rows 里每行都有 `availability` 对象（planId → 布尔）与 `id`。
 * 这是**全站唯一能把插件的 planId 和模型对上号**的地方，也是可用性的权威来源。
 *
 * @param {string} text RSC 正文。
 * @returns {{ rows: object[] }|undefined}
 */
export function parseAvailability(text) {
  for (const record of parseFlightRecords(text)) {
    const props = componentProps(record.value);
    if (props === undefined || !Array.isArray(props.rows)) continue;
    const rows = props.rows;
    if (rows.length === 0) continue;
    const matches = rows.filter((row) => row !== null && typeof row === 'object'
      && typeof row.id === 'string' && row.availability !== null && typeof row.availability === 'object');
    if (matches.length !== rows.length) continue;
    return { rows };
  }
  return undefined;
}

/**
 * 找定价页里那张套餐级概览表（Plan / Price / Credits / **Included LLM Usage** / Models）。
 *
 * 它是 JSX 树而不是数据数组，所以这里按表头文案做结构签名，再把每行的
 * 「Included LLM Usage」单元格拼成文本（`~75K requests`）并解析出量级。
 *
 * @param {string} text RSC 正文。
 * @returns {Array<{ label: string, price: string, credits: string, usageText: string, requests?: number }>}
 */
export function parsePlanLevel(text) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      // `["$","table",...]`：先看是不是那张表。
      if (node[0] === '$' && node[1] === 'table') {
        const props = componentProps(node);
        const headers = props === undefined ? [] : headerCells(props.children);
        const usageColumn = headers.indexOf('Included LLM Usage');
        if (usageColumn !== -1) {
          for (const row of bodyRows(props.children)) {
            const cells = row;
            const usageText = unescapeDollars(cells[usageColumn]);
            found.push({
              label: unescapeDollars(cells[0]),
              price: unescapeDollars(cells[1]),
              credits: unescapeDollars(cells[2]),
              usageText,
              requests: parseApproxCount(usageText),
            });
          }
        }
      }
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === 'object' && 'children' in node) walk(node.children);
  };
  for (const record of parseFlightRecords(text)) walk(record.value);
  return found;
}

/** 从表格 JSX 里取表头单元格文本。 */
function headerCells(children) {
  const cells = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      if (node[0] === '$' && node[1] === 'th') cells.push(collectText(componentProps(node)?.children));
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === 'object' && 'children' in node) walk(node.children);
  };
  walk(children);
  return cells;
}

/** 从表格 JSX 里取每行的单元格文本（跳过表头）。 */
function bodyRows(children) {
  const rows = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      if (node[0] === '$' && node[1] === 'tr') {
        const props = componentProps(node);
        const cells = [];
        const cellWalk = (child) => {
          if (Array.isArray(child)) {
            if (child[0] === '$' && child[1] === 'td') cells.push(collectText(componentProps(child)?.children));
            child.forEach(cellWalk);
            return;
          }
          if (child !== null && typeof child === 'object' && 'children' in child) cellWalk(child.children);
        };
        cellWalk(props?.children);
        if (cells.length > 0) rows.push(cells);
        return;
      }
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === 'object' && 'children' in node) walk(node.children);
  };
  walk(children);
  return rows;
}

/** `~75K requests` / `~9K requests` → 75000 / 9000；认不出就 undefined，不猜。 */
export function parseApproxCount(text) {
  const match = /~\s*([0-9.]+)\s*([KkMm])?/.exec(String(text ?? ''));
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const scale = match[2] === undefined ? 1 : match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  return Math.round(value * scale);
}

/**
 * 复刻站点的次数换算。
 *
 * @param {{ budgetUsd: number, rates: object, shape: object, timeOfDay?: object }} row 官方一行。
 * @param {{ fiveHourFraction: number, weeklyFraction: number }} fractions 窗口系数。
 * @param {number} [now] 当前时刻，用于判断峰谷价是否生效（默认 `Date.now()`）。
 * @returns {{ monthly: number, fiveHour: number, week: number, free: boolean, peak?: object }}
 */
export function computeAllowance(row, fractions, now = Date.now()) {
  const rates = effectiveRates(row, now);
  const monthly = requestsFor(row.budgetUsd, rates, row.shape);
  const result = {
    monthly,
    fiveHour: monthly * fractions.fiveHourFraction,
    week: monthly * fractions.weeklyFraction,
    free: !Number.isFinite(monthly),
  };
  // 峰时价只进 tooltip：站点默认展示谷时（off-peak）口径，我们跟它一致。
  const peak = row?.timeOfDay?.peak;
  if (peak !== undefined && isPeakActive(row, now)) {
    const peakMonthly = requestsFor(row.budgetUsd, peak, row.shape);
    result.peak = {
      monthly: peakMonthly,
      fiveHour: peakMonthly * fractions.fiveHourFraction,
      week: peakMonthly * fractions.weeklyFraction,
    };
  }
  return result;
}

/** 峰谷价是否已生效（官方在 `timeOfDay.effective` 之后改用 off-peak 展示）。 */
function isPeakActive(row, now) {
  return row?.timeOfDay !== undefined && row.timeOfDay !== null
    && typeof row.timeOfDay.effective === 'string'
    && now >= Date.parse(row.timeOfDay.effective);
}

/**
 * 这一行实际参与计算的单价。
 *
 * 存进目录是为了**可复算**：任何人拿到 `budgetUsd` + `rates` + `shape`，用同一个公式
 * 就能算出界面上的次数，不必相信我们的中间结果。
 */
export function effectiveRates(row, now = Date.now()) {
  const offPeak = row?.timeOfDay?.offPeak;
  if (isPeakActive(row, now) && offPeak !== undefined) return offPeak;
  return row?.rates ?? {};
}

/** 单次请求成本 → 月次数。成本 ≤ 0（免费模型）就是无限次，和站点一样。 */
function requestsFor(budgetUsd, rates, shape) {
  if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd)) return undefined;
  const cost = ((shape?.inputTokens ?? 0) / 1e6) * (rates?.inputCost ?? 0)
    + ((shape?.outputTokens ?? 0) / 1e6) * (rates?.outputCost ?? 0)
    + ((shape?.cacheReadTokens ?? 0) / 1e6) * (rates?.cacheReadCost ?? 0);
  if (!(cost > 0)) return Number.POSITIVE_INFINITY;
  return budgetUsd / cost;
}

/**
 * 把一页套餐文档解析成目录里的一个套餐条目。
 *
 * @param {string} planId 官方 planId。
 * @param {string} text RSC 正文。
 * @param {object} [options] `{ now, availability }`。
 * @returns {{ entry: object }|{ error: { code: string, message: string } }}
 */
export function parsePlanCatalog(planId, text, options = {}) {
  const doc = PLAN_DOC_URLS[planId];
  if (doc === undefined) {
    return { error: { code: 'PLAN_NOT_PUBLISHED', message: `官方没有发布 ${planId} 的模型次数表` } };
  }
  const estimates = parseEstimates(text);
  if (estimates === undefined) {
    // 两种失败要分开报，否则诊断会指错方向：
    //  - 一条记录都解析不出来、正文里却有字段名 → 官方改了分片方式，解析器跟不上；
    //  - 记录解析出来了、结构却是另一个样子 → 站点改版。
    const parsedRecords = parseFlightRecords(text).length;
    const sawFields = /"budgetUsd"|"fiveHourFraction"/.test(String(text));
    const split = parsedRecords === 0 && sawFields;
    return {
      error: split
        ? { code: 'PARSE_SPLIT_RECORD', message: `${doc.url} 的正文含次数表字段但无法整条解析（官方可能改了分片方式）` }
        : { code: 'PARSE_MISMATCH', message: `${doc.url} 里找不到模型次数表（站点可能改版）` },
    };
  }
  // Go 两代按 planId 取权威窗口（见 GO_FRACTIONS）；其余档位用页面 props。
  const fractions = GO_FRACTIONS[planId]
    ?? { fiveHourFraction: estimates.fiveHourFraction, weeklyFraction: estimates.weeklyFraction };

  // 可用性数据（定价页）是精简后的形状：{ id, name, deprecated?, availableIn: [planId…] }。
  const availability = Array.isArray(options.availability) ? options.availability : [];
  const availabilityById = new Map();
  for (const row of availability) {
    const key = normalizeModelKey(row.id);
    if (key !== undefined) availabilityById.set(key, row);
  }

  // 整页共用的「典型请求形状」：进 entry 级 basis，逐行只在不同时才重复存。
  const firstShape = estimates.rows.find((row) => row?.shape !== undefined)?.shape;
  const models = [];
  const seen = new Set();
  for (const row of estimates.rows) {
    if (row === null || typeof row !== 'object' || typeof row.name !== 'string') continue;
    const key = normalizeModelKey(row.name);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    const allowance = computeAllowance(row, fractions, options.now);
    const meta = availabilityById.get(key);
    const rates = effectiveRates(row, options.now);
    models.push({
      key,
      name: row.name,
      modelId: typeof meta?.id === 'string' ? meta.id : undefined,
      // 复算所需的全部输入：budgetUsd + rates + shape，任何人用同一个公式都能算出
      // 界面上的次数，不必相信我们的中间结果。
      budgetUsd: row.budgetUsd,
      rates: {
        inputCost: rates.inputCost,
        outputCost: rates.outputCost,
        cacheReadCost: rates.cacheReadCost,
      },
      shape: row.shape === undefined || sameShape(row.shape, firstShape) ? undefined : {
        inputTokens: row.shape.inputTokens,
        outputTokens: row.shape.outputTokens,
        cacheReadTokens: row.shape.cacheReadTokens,
      },
      monthly: allowance.monthly,
      fiveHour: allowance.fiveHour,
      week: allowance.week,
      free: allowance.free,
      peak: allowance.peak,
      source: 'plan-doc',
    });
  }

  // 官方表不覆盖全部可用模型（GOAT 51/63）：把「套餐能用但官方套餐页没给次数」的
  // 模型补上。定价页的计算器里通常有它们的逐档额度与单价，那就按官方自己的做法
  // 推一个形状算出来（打上 shapeSource 标记），真的一点数据都没有才显示「—」。
  const extras = [];
  for (const row of availability) {
    if (typeof row.id !== 'string' || row.deprecated === true) continue;
    if (!Array.isArray(row.availableIn) || !row.availableIn.includes(planId)) continue;
    const key = normalizeModelKey(row.id);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    const tier = PLAN_CALCULATOR_TIERS[planId];
    const budgetUsd = tier === undefined ? undefined : row.allowanceByTier?.[tier];
    const derived = typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && row.rates !== undefined
      ? (() => {
        const shape = derivedShape(row.provider);
        return { shape, allowance: computeAllowance({ budgetUsd, rates: row.rates, shape }, fractions, options.now) };
      })()
      : undefined;
    extras.push({
      key,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
      modelId: row.id,
      budgetUsd: derived === undefined ? undefined : budgetUsd,
      rates: derived === undefined ? undefined : row.rates,
      shape: derived === undefined ? undefined : derived.shape,
      // 推导来的数字必须能被认出来：界面据此说明「按官方 provider 默认形状推算」。
      shapeSource: derived === undefined ? undefined : 'derived-from-provider',
      monthly: derived?.allowance.monthly,
      fiveHour: derived?.allowance.fiveHour,
      week: derived?.allowance.week,
      // 免费模型没有「次数」这回事：官方自己渲染成 "Free"。它属于「有数据」，
      // 不属于「官方没公布」。
      free: derived?.allowance.free ?? row.free === true,
      source: derived === undefined ? (row.free === true ? 'free' : 'availability-only') : 'derived',
    });
  }
  extras.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    entry: {
      planId,
      planName: doc.name,
      docUrl: doc.url,
      inferredFrom: doc.inferred,
      fractions,
      basis: firstShape === undefined ? undefined : {
        inputTokens: firstShape.inputTokens,
        outputTokens: firstShape.outputTokens,
        cacheReadTokens: firstShape.cacheReadTokens,
      },
      models: [...models, ...extras],
      publishedModels: models.length,
      availableModels: extras.length + models.length,
    },
  };
}

/** 两行是否共用同一个「典型请求形状」；大多数页面整页共用一个，逐行重复存只是浪费空间。 */
function sameShape(a, b) {
  return a !== undefined && b !== undefined
    && a.inputTokens === b.inputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens;
}

/** SHA-256 摘要，用于「内容真的变了吗」的比对（官方不给 304，只能自己算）。 */
export function contentDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 读缓存；坏了、版本不认识、schema 变了都当没有 —— 从不因为一个坏文件让面板报错。 */
export function readCatalogCache(options = {}) {
  const file = options.file ?? catalogCachePath(options);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    if (parsed.kind !== CATALOG_KIND || parsed.version !== CATALOG_VERSION) return undefined;
    if (parsed.schema !== CATALOG_SCHEMA) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 读内置基线；同样宽容。 */
export function readCatalogSeed(options = {}) {
  const file = options.file ?? catalogSeedPath();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    if (parsed.kind !== CATALOG_KIND || parsed.version !== CATALOG_VERSION) return undefined;
    if (parsed.schema !== CATALOG_SCHEMA) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 原子写目录缓存：同目录临时文件 + rename，权限跟额度快照一致（目录 0700 / 文件 0600）。
 * @param {object} catalog 目录对象。
 * @param {object} [options] `{ file }` 覆盖落点。
 */
export function writeCatalogAtomic(catalog, options = {}) {
  const file = options.file ?? catalogCachePath(options);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(catalog), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
}

/**
 * 带上固定请求头抓一页，返回正文、ETag 与摘要。
 *
 * @param {string} url 目标地址。
 * @param {object} [options] `{ method, fetchImpl, timeoutMs }`。
 * @returns {Promise<{ status: number, etag?: string, text?: string, digest?: string }>}
 * @throws {Error} 传输失败或超时。
 */
export async function fetchCatalogDoc(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: options.method ?? 'GET',
    headers: { ...CATALOG_REQUEST_HEADERS, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(options.timeoutMs ?? CATALOG_TIMEOUT_MS),
    redirect: 'follow',
  });
  const result = { status: response.status, etag: stripWeak(response.headers.get('etag')), finalUrl: response.url };
  if (options.method === 'HEAD' || response.status !== 200) return result;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_BODY_BYTES) throw new Error(`${url} 返回体过大（${buffer.byteLength} 字节）`);
  return { ...result, text: buffer.toString('utf8'), digest: contentDigest(buffer) };
}

/**
 * planId → 定价页计算器里的档位键。
 *
 * 计算器只覆盖 go / goat / pro（官方只公布这三档的逐模型 `planAllowanceUsd`）。
 * Max 与 Ultra 在那一页只有档位级概览，没有逐模型额度，所以对它们不做按量推导。
 */
export const PLAN_CALCULATOR_TIERS = Object.freeze({
  'individual-go': 'go',
  'individual-go-v1': 'go',
  'individual-goat': 'goat',
  'individual-pro': 'pro',
  'individual-pro-v1': 'pro',
});

/**
 * 官方计算器在模型没有自带 `shape` 时，按 provider 推输出 token 数；未收录的落 200。
 *
 * 这份映射抄自站点自己的源码。注意套餐页的 `rows[]` **总是**带 `shape`，所以它只
 * 用于「套餐页没列、但定价页有额度」的那些模型 —— 推导出来的数字会打上
 * `shapeSource: 'derived-from-provider'`，界面必须说明它是推算的。
 */
const PROVIDER_OUTPUT_TOKENS = Object.freeze({
  Anthropic: 180,
  OpenAI: 160,
  'Moonshot AI': 200,
  'Z.ai': 150,
  MiniMax: 125,
  DeepSeek: 200,
  Alibaba: 200,
  StepFun: 200,
});

/** 推导形状里与 provider 无关的两项：官方固定 800 输入 / 50,000 缓存读。 */
const DERIVED_INPUT_TOKENS = 800;
const DERIVED_CACHE_READ_TOKENS = 50_000;
const DEFAULT_OUTPUT_TOKENS = 200;

/**
 * 解析定价页：模型可用性（精简字段）+ 每模型额度 + 套餐级概览表。
 *
 * 这一页承担两件事：planId → 模型可用性（全站唯一能把插件的 planId 和模型对上号
 * 的地方），以及**计算器**里每个模型的逐档额度与单价 —— 套餐页没列出的模型靠它
 * 才有次数可算，否则那些模型只能显示「官方未给次数」。
 *
 * @param {string} text RSC 正文。
 * @returns {{ models: object[], planLevel: object[] }|{ error: { code: string, message: string } }}
 */
export function parsePricingCatalog(text) {
  const availability = parseAvailability(text);
  const planLevel = parsePlanLevel(text);
  const calculator = parseCalculator(text);
  if (availability === undefined && planLevel.length === 0) {
    return { error: { code: 'PARSE_MISMATCH', message: `${PRICING_DOC_URL} 里既没有可用性表也没有套餐概览表（站点可能改版）` } };
  }
  const byKey = new Map();
  for (const row of calculator) {
    const key = normalizeModelKey(row.id);
    if (key !== undefined) byKey.set(key, row);
  }
  const models = [];
  for (const row of availability?.rows ?? []) {
    if (typeof row.id !== 'string') continue;
    const availableIn = Object.entries(row.availability ?? {})
      .filter(([planId, ok]) => ok === true && planId !== 'all')
      .map(([planId]) => planId);
    const extra = byKey.get(normalizeModelKey(row.id));
    models.push({
      id: row.id,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
      deprecated: row.deprecated === true,
      availableIn,
      // 免费模型（官方标注 deal.free / 单价全 0）应显示 "Free"，不该被塞进
      // 「官方没公布次数」那一桶 —— 它们不是没数据，是数据就是无限。
      free: row.deal?.free === true
        || (Array.isArray(row.tiers) && row.tiers.length > 0
          && [row.tiers[0]?.rates?.input, row.tiers[0]?.rates?.output, row.tiers[0]?.rates?.cacheRead]
            .every((rate) => rate === 0)),
      // 计算器里的逐档额度与单价：套餐页没列出的模型靠它拿次数。
      provider: extra?.provider,
      allowanceByTier: extra?.allowanceByTier,
      rates: extra?.rates,
    });
  }
  return { models, planLevel };
}

/**
 * 解析定价页的「计算器」表：每模型的 provider、逐档额度与单价。
 *
 * 结构签名：props.models 里每行都带 `planAllowanceUsd`（对象）与三个数值单价。
 * 该表**按设计不带 `shape`** —— 缺形状时由 provider 推导，见上面的映射表。
 *
 * @param {string} text RSC 正文。
 * @returns {Array<{ id: string, provider?: string, allowanceByTier?: object, rates?: object }>}
 */
export function parseCalculator(text) {
  for (const record of parseFlightRecords(text)) {
    const props = componentProps(record.value);
    if (props === undefined || !Array.isArray(props.models) || props.models.length === 0) continue;
    const rows = props.models.filter((row) => row !== null && typeof row === 'object'
      && typeof row.id === 'string'
      && row.planAllowanceUsd !== null && typeof row.planAllowanceUsd === 'object'
      && typeof row.inputCost === 'number');
    if (rows.length !== props.models.length) continue;
    return rows.map((row) => ({
      id: row.id,
      provider: typeof row.provider === 'string' ? row.provider : undefined,
      allowanceByTier: row.planAllowanceUsd,
      rates: { inputCost: row.inputCost, outputCost: row.outputCost, cacheReadCost: row.cacheReadCost },
    }));
  }
  return [];
}

/**
 * 一个没有官方 `shape` 的模型，按 provider 推出的典型请求形状。
 * @param {string|undefined} provider 官方 provider 名。
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number }}
 */
export function derivedShape(provider) {
  const mapped = typeof provider === 'string' ? PROVIDER_OUTPUT_TOKENS[provider] : undefined;
  return {
    inputTokens: DERIVED_INPUT_TOKENS,
    outputTokens: mapped ?? DEFAULT_OUTPUT_TOKENS,
    cacheReadTokens: DERIVED_CACHE_READ_TOKENS,
  };
}

/**
 * 现在该不该去核对官方？纯本地判断，不联网。
 *
 * 成功核对过 → 等满 TTL；上一轮有失败 → 至少隔 {@link CATALOG_MIN_RETRY_MS} 再试，
 * 既不因为一次断网就把一整天的机会浪费掉，也不会变成轮询。
 *
 * @param {object} args `{ catalog, now, ttlMs, minRetryMs }`。
 * @returns {boolean}
 */
export function needsRevalidate({ catalog, planId, now = Date.now(), ttlMs = CATALOG_TTL_MS, minRetryMs = CATALOG_MIN_RETRY_MS }) {
  if (catalog === undefined) return true;
  // 换了套餐（或第一次拿到 planId）而本地没有这一档：立刻补一次，别等满 TTL。
  if (planId !== undefined && catalog.plans?.[planId] === undefined) return true;
  const checked = Date.parse(catalog.checkedAt ?? '');
  if (!Number.isFinite(checked)) return true;
  const failing = Array.isArray(catalog.failures) && catalog.failures.length > 0;
  return now - checked >= (failing ? minRetryMs : ttlMs);
}

/**
 * 核对并按需下载官方页面，返回新的目录对象。
 *
 * 「没变就不抓」的实现：先 `HEAD + RSC: 1`（**0 字节**）比对上次存的 ETag；一致就直接
 * 沿用缓存。官方忽略所有 `If-*` 条件头，所以这是唯一能做到「不变就不下载正文」的办法。
 * ETag 不可用时退化为「GET 后比内容摘要」——多一次正文下载，判定不变时同样不重解析、
 * 不改 `updatedAt`、不报降级。
 *
 * 失败不清空：某个页面抓不到就保留它上一次成功的解析结果，并把失败写进 `failures`。
 *
 * @param {object} [config]
 * @param {string} [config.planId] 当前账号套餐；只为它抓对应的套餐页。
 * @param {object} [config.previous] 已有目录；省略则读缓存。
 * @param {object} [config.env] 环境变量表（密钥兜底扫描与 TTL 覆盖）。
 * @param {typeof fetch} [config.fetchImpl] 注入 fetch，便于测试。
 * @param {number} [config.now] 当前时刻。
 * @param {string} [config.file] 缓存落点；`write: false` 时不写盘。
 * @param {boolean} [config.write] 是否写缓存，默认 true。
 * @returns {Promise<{ catalog: object, changed: boolean, failures: object[] }>}
 */
export async function syncCatalog(config = {}) {
  const now = config.now ?? Date.now();
  const file = config.file ?? catalogCachePath(config);
  const previous = config.previous ?? readCatalogCache({ file });
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const at = new Date(now).toISOString();

  /** url → 该页服务的 planId 列表（定价页服务全部）。 */
  const wanted = new Map([[PRICING_DOC_URL, []]]);
  for (const planId of [config.planId, ...(config.extraPlanIds ?? [])]) {
    const doc = PLAN_DOC_URLS[planId];
    if (doc === undefined) continue;
    wanted.set(doc.url, [...(wanted.get(doc.url) ?? []), planId]);
  }

  const failures = [];
  const validators = { ...(previous?.validators ?? {}) };
  const plans = { ...(previous?.plans ?? {}) };
  let pricing = previous?.pricing;
  let planLevel = previous?.planLevel;
  let changed = false;
  /** 本次核对有没有被迫用「整篇比对」（HEAD 不可用）而不是 0 字节的 ETag 探针。 */
  let usedHashMode = false;

  // 定价页先处理：套餐页要用它的可用性数据。
  const order = [PRICING_DOC_URL, ...[...wanted.keys()].filter((url) => url !== PRICING_DOC_URL)];
  for (const url of order) {
    const stored = validators[url];
    let fresh;
    try {
      // 第一跳：HEAD 只取 ETag，0 字节。HEAD 被网关拒绝（405/501）或没给 ETag 时
      // **不能让整个目录卡死** —— 退化为「GET 后比整篇摘要」，多一次正文下载，
      // 但判定「没变」的效果一样。
      let headEtag;
      let headUsable = false;
      try {
        const head = await fetchCatalogDoc(url, { method: 'HEAD', fetchImpl, timeoutMs });
        if (head.status === 200 && head.etag !== undefined) {
          headUsable = true;
          headEtag = head.etag;
        }
      } catch {
        // HEAD 本身失败：走 GET 兜底，不记为一次失败。
      }
      if (headUsable && stored?.etag !== undefined && stored.etag === headEtag) {
        // 0 字节就确认「没变」：不下载、不重解析、不改 updatedAt。
        continue;
      }
      if (!headUsable) usedHashMode = true;
      const get = await fetchCatalogDoc(url, { method: 'GET', fetchImpl, timeoutMs });
      if (get.status !== 200) {
        const error = new Error(`HTTP ${get.status}`);
        error.status = get.status;
        error.finalUrl = get.finalUrl;
        throw error;
      }
      if (stored?.digest !== undefined && get.digest === stored.digest) {
        validators[url] = { etag: get.etag ?? stored.etag, digest: get.digest };
        continue;
      }
      fresh = { text: get.text, etag: get.etag, digest: get.digest };
    } catch (error) {
      failures.push({
        code: error?.status === 404 ? 'CATALOG_HTTP_404' : 'CATALOG_NETWORK',
        url,
        status: error?.status,
        finalUrl: error?.finalUrl,
        message: `${url}: ${error instanceof Error ? error.message : String(error)}`,
        at,
      });
      continue;
    }

    if (url === PRICING_DOC_URL) {
      const parsed = parsePricingCatalog(fresh.text);
      if ('error' in parsed) {
        failures.push({ ...parsed.error, url, at });
        continue;
      }
      pricing = { models: parsed.models, fetchedAt: at };
      planLevel = { rows: parsed.planLevel, fetchedAt: at, sourceUrl: PRICING_DOC_URL };
      validators[url] = { etag: fresh.etag, digest: fresh.digest };
      changed = true;
      continue;
    }

    let parsedAny = false;
    for (const planId of wanted.get(url) ?? []) {
      const parsed = parsePlanCatalog(planId, fresh.text, { now, availability: pricing?.models });
      if ('error' in parsed) {
        failures.push({ ...parsed.error, planId, url, at });
        continue;
      }
      plans[planId] = { ...parsed.entry, fetchedAt: at };
      parsedAny = true;
      changed = true;
    }
    // 只有真的解析出东西，才把这个 ETag 记下来。
    //
    // 反例（曾经就是这样）：正文抓到了、解析失败，却仍存下 ETag —— 下一次核对
    // 看到 ETag 没变就跳过，于是「官方改版」这件事只报一次，然后永久静默，那一档
    // 永远没有数据。失败必须每次都报，直到真的解析成功为止。
    if (parsedAny) validators[url] = { etag: fresh.etag, digest: fresh.digest };
  }

  const hasData = Object.keys(plans).length > 0 || pricing !== undefined;
  const catalog = {
    kind: CATALOG_KIND,
    version: CATALOG_VERSION,
    schema: CATALOG_SCHEMA,
    // updatedAt 只在内容真的变了时前进：界面据此说「官方更新于…」。
    updatedAt: changed ? at : (previous?.updatedAt ?? at),
    checkedAt: at,
    // 'etag' = 这次核对靠 0 字节 HEAD 完成；'hash' = HEAD 不可用，改用整篇摘要比对。
    fetchMode: usedHashMode ? 'hash' : 'etag',
    plans,
    pricing,
    planLevel,
    validators,
    failures,
  };
  if (hasData && config.write !== false) writeCatalogAtomic(catalog, { file });
  return { catalog, changed, failures };
}

/**
 * 一次拿齐「界面现在该显示什么」：缓存 → 内置基线 → 空视图。
 *
 * @param {object} [options] `{ planId, configuredModels, env, home, dshHome, file, now, ttlMs }`。
 * @returns {object} {@link catalogView} 的产物。
 */
export function resolveCatalogView(options = {}) {
  const cached = readCatalogCache(options);
  const catalog = cached ?? readCatalogSeed(options);
  return catalogView({
    catalog,
    bundled: cached === undefined,
    planId: options.planId,
    configuredModels: options.configuredModels ?? [],
    now: options.now ?? Date.now(),
    ttlMs: resolveCatalogTtlMs(options),
  });
}

/**
 * 把一份已解析的目录投影成界面/命令要看的视图。
 *
 * 纯本地、不发请求：调用方决定何时核对，这里只回答「现在知道什么」。
 * 缺失一律留空并说明，绝不用 0 或猜测填坑。
 *
 * @param {object} args
 * @param {object|undefined} args.catalog 缓存或 seed。
 * @param {boolean} args.bundled 是否来自内置 seed。
 * @param {string|undefined} args.planId 当前账号的套餐。
 * @param {string[]} [args.configuredModels] 用户自己在 DSH 里配的模型（原始 id/名）。
 * @param {number} [args.now]
 * @param {number} [args.ttlMs]
 * @returns {object} 视图。
 */
export function catalogView({ catalog, bundled, planId, configuredModels = [], now = Date.now(), ttlMs = CATALOG_TTL_MS }) {
  const configured = new Set(configuredModels.map(normalizeModelKey).filter((key) => key !== undefined));
  const empty = {
    kind: CATALOG_KIND,
    schema: CATALOG_SCHEMA,
    origin: bundled ? 'bundled' : 'network',
    verified: bundled !== true,
    updatedAt: catalog?.updatedAt ?? null,
    checkedAt: catalog?.checkedAt ?? null,
    stale: true,
    neverSynced: catalog === undefined,
    fetchMode: catalog?.fetchMode ?? null,
    planId: planId ?? null,
    planName: undefined,
    docUrl: null,
    inferredFrom: undefined,
    basis: null,
    windows: null,
    planLevel: null,
    configuredModels: [...configured],
    models: [],
    coverage: { published: 0, available: 0 },
    failures: catalog?.failures ?? [],
    warnings: [],
  };
  if (catalog === undefined) return empty;

  const entry = planId === undefined ? undefined : catalog.plans?.[planId];
  const checkedAt = catalog.checkedAt;
  const age = typeof checkedAt === 'string' ? now - Date.parse(checkedAt) : Number.POSITIVE_INFINITY;
  const warnings = [];
  if (entry === undefined && planId !== undefined) {
    warnings.push(catalog.plans?.[planId] === undefined ? `catalog-plan-not-listed:${planId}` : 'catalog-plan-missing');
  }
  if (bundled === true) warnings.push('catalog-bundled-baseline');

  const models = [];
  for (const model of entry?.models ?? []) {
    models.push({
      key: model.key,
      name: model.name,
      modelId: model.modelId,
      monthly: model.monthly,
      fiveHour: model.fiveHour,
      week: model.week,
      free: model.free === true,
      peak: model.peak,
      configured: configured.has(model.key),
      // 有数字（官方套餐页给的，或按官方计算器+provider 默认形状推的）vs 完全没有。
      estimated: model.source === 'plan-doc' || model.source === 'derived',
      // 推算来的：界面必须说明它来自 provider 默认形状，而不是套餐页公布的形状。
      derived: model.source === 'derived',
      shapeSource: model.shapeSource,
    });
  }
  // 你配的模型置顶；同组内官方给了次数的在前，名字升序，保证顺序稳定可预期。
  models.sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    if (a.estimated !== b.estimated) return a.estimated ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const planLevelRow = entry === undefined
    ? undefined
    : (catalog.planLevel?.rows ?? []).find((row) => row.label === entry.planName || row.label.startsWith(entry.planName));

  return {
    ...empty,
    planName: entry?.planName,
    docUrl: entry?.docUrl ?? null,
    inferredFrom: entry?.inferredFrom,
    basis: entry?.basis ?? null,
    windows: entry?.fractions ?? null,
    planLevel: planLevelRow === undefined ? null : {
      label: planLevelRow.label,
      credits: planLevelRow.credits,
      requestsText: planLevelRow.usageText,
      requests: planLevelRow.requests,
      sourceUrl: PRICING_DOC_URL,
    },
    models,
    coverage: {
      published: entry?.publishedModels ?? 0,
      derived: (entry?.models ?? []).filter((model) => model.source === 'derived').length,
      available: entry?.availableModels ?? 0,
    },    stale: !(Number.isFinite(age) && age < ttlMs),
    warnings,
  };
}
