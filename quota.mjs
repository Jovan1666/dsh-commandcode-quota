/**
 * Command Code 账号额度只读数据层。
 *
 * 只做三件事：解析 API key、调用官方四个 `/alpha` 端点、把响应归一成一个与
 * 展示层无关的报告对象。零依赖，Node 18+ 的全局 `fetch` 即可运行；要做 DSH
 * 插件时，本模块可以原样搬进 Host 半。
 *
 * 端点契约来自 `@mars-sea/dsh-commandcode-provider` 的 adapter（MIT）。
 *
 * @module commandcode-quota/lib
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Command Code Provider API 的默认地址。 */
export const DEFAULT_API_BASE = 'https://api.commandcode.ai';

/** 单次请求超时；官方端点正常在 1s 内返回。 */
export const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 密钥来源环境变量，按此顺序尝试。第一个是 DSH 里 `llm-pi-ai` 那条 provider
 * 正在用的名字，后两个是官方 CLI 生态的常见名字。
 */
/**
 * Fallback名字列表。真正的首选来源不是这里，而是从用户自己的 DSH 设置里
 * **发现** Command Code 路由（见 {@link discoverRoutes}）——每个用户给 provider
 * 起的名字、用的环境变量名都不一样，写死任何一个都只对一个人有效。
 */
export const KEY_ENV_NAMES = Object.freeze([
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
  'CMD_API_KEY',
]);

/** 环境变量名里出现这些片段就当作候选（兜住任意自定义命名）。 */
const KEY_ENV_PATTERN = /command_?code/i;

/** 判定一个 baseURL 是否指向 Command Code 的官方 API。 */
const COMMANDCODE_HOST_PATTERN = /(^|\/\/|\.)commandcode\.ai(\/|$)/i;

/**
 * 取一个 provider baseURL 的 origin。
 *
 * provider 的 baseURL 带路径（官方是 `https://api.commandcode.ai/provider/v1`），
 * 但额度用的 `/alpha/*` 端点在主机**根路径**上——直接把 baseURL 当 base 会请求到
 * `.../provider/v1/alpha/...`。只保留 origin 既纠正了路径，又保留了用户对主机的
 * 选择（比如指向 staging）。
 *
 * @param {string} url provider 路由的 baseURL。
 * @returns {string | undefined} origin，无法解析时返回 undefined。
 */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    // baseURL 不是合法 URL：当作没有发现地址，回落到官方默认值。
    return undefined;
  }
}

/**
 * 请求头里声明的 CLI 版本。服务端用它区分调用来源与能力，不参与鉴权；填一个
 * 近期版本即可。
 */
const CLI_VERSION = '1.54.2';

/** 四个只读 GET 端点。`subscription` 在 whoami 报出 orgId 时需要带上查询参数。 */
const ENDPOINTS = Object.freeze({
  whoami: '/alpha/whoami',
  usage: '/alpha/usage/summary',
  credits: '/alpha/billing/credits',
  subscription: '/alpha/billing/subscriptions',
});

/**
 * 订阅 planId → 展示名与名义月度额度。取自官方 CLI bundle 的 plan map
 * （与 `@mars-sea/dsh-commandcode-provider` 同步自 command-code@1.53.0）。
 * 按前缀最长优先匹配，因此 `individual-pro-v1` 先于 `individual-pro` 命中。
 */
const SUBSCRIPTION_PLANS = Object.freeze({
  'individual-go': { name: 'Go', monthlyCredits: 10 },
  'individual-goat': { name: 'GOAT', monthlyCredits: 70 },
  'individual-pro': { name: 'Pro', monthlyCredits: 30 },
  'individual-pro-v1': { name: 'Pro', monthlyCredits: 80 },
  'individual-provider': { name: 'Provider', monthlyCredits: 15 },
  'individual-max': { name: 'Max', monthlyCredits: 150 },
  'individual-ultra': { name: 'Ultra', monthlyCredits: 300 },
  'teams-pro': { name: 'Teams Pro', monthlyCredits: 40 },
});

const PLAN_PREFIXES = Object.keys(SUBSCRIPTION_PLANS).sort((a, b) => b.length - a.length);

/**
 * 数据层对外抛出的唯一错误类型。
 *
 * `code` 取 `MISSING_CREDENTIAL`（本地没有可用 key）、`AUTH`（401/403）、
 * `NOT_FOUND`（404，通常是套餐不含 API 权限）、`RATE_LIMIT`（429）、
 * `SERVICE`（5xx）、`NETWORK`（传输失败）、`BAD_RESPONSE`（非 JSON）。
 */
export class QuotaError extends Error {
  /**
   * @param {string} code 稳定错误码，见类文档。
   * @param {string} message 面向使用者的说明。
   * @param {object} [details] 附带信息，如 HTTP 状态码。
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QuotaError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * 把订阅 planId 解析成展示名与名义月度额度。
 *
 * @param {string | undefined} planId 官方 `subscriptions.data.planId`。
 * @returns {{ name: string, monthlyCredits: number } | undefined} 未收录的 id 返回 undefined。
 */
export function subscriptionPlanInfo(planId) {
  if (typeof planId !== 'string' || planId === '') return undefined;
  const normalized = planId.toLowerCase().replace(/_/g, '-');
  const prefix = PLAN_PREFIXES.find((candidate) => normalized.startsWith(candidate));
  return prefix === undefined ? undefined : SUBSCRIPTION_PLANS[prefix];
}

/** 有限数字才认，其余（含字符串数字）一律当缺字段。 */
function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOf(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从 DSH 凭据文件里取一个 `refs.<NAME>: <value>` 形式的明文密钥。
 *
 * 只做行级匹配，不引入 YAML 依赖：凭据文件由 DSH 自己写，格式稳定。
 *
 * @param {string} file 凭据文件路径。
 * @param {string} name 引用名。
 * @returns {string | undefined} 文件不存在、无该引用或值为空时返回 undefined。
 */
function readCredentialRef(file, name) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // 文件不存在或不可读都按"这个来源没有 key"处理：调用方还会试下一个来源。
    return undefined;
  }
  const match = raw.match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm'));
  if (match === null) return undefined;
  const value = match[1].replace(/^['"]|['"]$/g, '');
  return value === '' ? undefined : value;
}

/**
 * 读取官方 `command-code` CLI 的登录态文件。
 *
 * @param {string} file `~/.commandcode/auth.json`。
 * @returns {string | undefined} 未登录或字段不认识时返回 undefined。
 */
function readOfficialAuthFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // 未安装官方 CLI 是常态，直接跳到"没有这个来源"。
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    return stringOf(parsed.apiKey) ?? stringOf(parsed.token) ?? stringOf(parsed.access_token);
  } catch {
    // 文件存在但不是 JSON：保留给下一次解析，不让它盖过其他来源。
    return undefined;
  }
}

/**
 * 从 DSH settings.yaml 里发现所有指向 Command Code 的 provider 路由。
 *
 * 只做行级缩进扫描，不引入 YAML 依赖：settings.yaml 是 DSH 自己写的、结构稳定，
 * 而这里只需要"某个 baseURL 指向 commandcode.ai 的块里，它的 apiKeyEnv/apiKey 是
 * 什么"。这样无论用户把 provider 路由叫 `command-code-goat` 还是别的、环境变量叫
 * `COMMAND_CODE_GOAT_API_KEY` 还是 `MY_CMD_KEY`，都能找到。
 *
 * 块边界由缩进决定，且**向两个方向**扫描同级兄弟行——settings.yaml 里 `apiKeyEnv`
 * 既可能写在 `baseURL` 之前也可能之后，只往后看会漏。
 *
 * @param {string} text settings.yaml 的内容。
 * @returns {Array<{ baseURL: string, keyRef?: string, apiKey?: string }>} 命中的路由，按文件出现顺序。
 */
export function discoverRoutes(text) {
  const lines = text.split(/\r?\n/).map((rawLine) => {
    const line = rawLine.replace(/\s+#.*$/, '');
    const trimmed = line.trim();
    return {
      indent: line.length - line.trimStart().length,
      trimmed,
      blank: trimmed === '' || trimmed.startsWith('#'),
    };
  });

  const routes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.blank) continue;
    const base = /^baseURL:\s*["']?([^"'\s]+)["']?/.exec(line.trimmed);
    if (base === null || !COMMANDCODE_HOST_PATTERN.test(base[1])) continue;

    const indent = line.indent;
    const route = { baseURL: base[1] };
    // Only same-indent siblings belong to this provider row; a deeper line is a
    // nested field (a model entry, say) and a shallower one closes the block.
    const readSibling = (candidate) => {
      if (candidate.blank || candidate.indent !== indent) return;
      const ref = /^apiKeyEnv:\s*["']?([^"'\s]+)["']?/.exec(candidate.trimmed);
      if (ref !== null && route.keyRef === undefined) {
        route.keyRef = ref[1];
        return;
      }
      const literal = /^apiKey:\s*["']?([^"'\s]+)["']?/.exec(candidate.trimmed);
      if (literal !== null && route.apiKey === undefined) route.apiKey = literal[1];
    };
    for (let back = index - 1; back >= 0 && (lines[back].blank || lines[back].indent >= indent); back -= 1) {
      readSibling(lines[back]);
    }
    for (let ahead = index + 1; ahead < lines.length && (lines[ahead].blank || lines[ahead].indent >= indent); ahead += 1) {
      readSibling(lines[ahead]);
    }
    routes.push(route);
  }
  return routes;
}

/**
 * 按固定优先级解析 API key，并回报来源，便于排查"为什么读不到 key"。
 *
 * 顺序：
 * 1. 显式传入（命令行 `--key`）
 * 2. **从 DSH 设置里发现**的 Command Code 路由：先取路由上的字面 `apiKey`，再按它的
 *    `apiKeyEnv` 去环境变量和 `$DSH_HOME/.credentials.yaml` 的 `refs` 里找
 * 3. 环境变量：通用名字列表 → 名字里含 `commandcode` 的任意变量
 * 4. `$DSH_HOME/.credentials.yaml` / `~/.dsh/.credentials.yaml` 的固定名字
 * 5. `~/.commandcode/auth.json`（官方 `command-code` CLI 的登录态）
 *
 * 第 2 步是给别的用户用的关键：它跟随用户自己的 provider 配置，而不是我们的命名习惯。
 * 发现到的 `baseURL` 会一并返回，让取数走用户实际配置的地址（可能是代理）。
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] 显式密钥，优先级最高。
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量表，默认 `process.env`。
 * @param {string} [options.home] 用户主目录，默认 `os.homedir()`。
 * @param {string} [options.dshHome] DSH 数据目录，默认 `$DSH_HOME` 或 `~/.dsh`。
 * @param {readonly string[]} [options.keyNames] 覆盖固定名字列表。
 * @returns {{ key: string, source: string, apiBase?: string }} 命中的密钥、来源与（可选）发现的地址。
 * @throws {QuotaError} 所有来源都为空时抛 `MISSING_CREDENTIAL`。
 */
export function resolveApiKey(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const dshHome = options.dshHome ?? env.DSH_HOME ?? path.join(home, '.dsh');
  const names = options.keyNames ?? KEY_ENV_NAMES;
  const settingsFiles = [
    path.join(dshHome, 'settings.yaml'),
    path.join(home, '.dsh', 'settings.yaml'),
  ];
  const credentialFiles = [
    path.join(dshHome, '.credentials.yaml'),
    path.join(home, '.dsh', '.credentials.yaml'),
  ];

  if (typeof options.apiKey === 'string' && options.apiKey !== '') {
    return { key: options.apiKey, source: '--key 参数' };
  }

  /**
   * 把一个引用名（环境变量名或凭据引用名）解析成密钥。
   * @param {string} ref 引用名。
   * @returns {{ key: string, source: string } | undefined} 命中结果。
   */
  const resolveRef = (ref) => {
    if (typeof ref !== 'string' || ref === '') return undefined;
    const fromEnv = env[ref];
    if (typeof fromEnv === 'string' && fromEnv !== '') return { key: fromEnv, source: `环境变量 ${ref}` };
    for (const file of credentialFiles) {
      const value = readCredentialRef(file, ref);
      if (value !== undefined) return { key: value, source: `${file} → refs.${ref}` };
    }
    return undefined;
  };

  // 2. 跟随用户自己的 provider 配置。
  let sawCommandCodeRoute = false;
  for (const file of settingsFiles) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // 没有这个 settings 文件就是"这个来源不存在"，继续下一个。
      continue;
    }
    for (const route of discoverRoutes(text)) {
      sawCommandCodeRoute = true;
      if (route.apiKey !== undefined) {
        return { key: route.apiKey, source: `${file} → provider apiKey`, apiBase: originOf(route.baseURL) };
      }
      const hit = resolveRef(route.keyRef);
      if (hit !== undefined) return { ...hit, apiBase: originOf(route.baseURL) };
    }
  }

  // 3. 环境变量：固定名字，再退到"名字像 Command Code 的任意变量"。
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') return { key: value, source: `环境变量 ${name}` };
  }
  for (const name of Object.keys(env)) {
    if (!KEY_ENV_PATTERN.test(name)) continue;
    const value = env[name];
    if (typeof value === 'string' && value !== '') return { key: value, source: `环境变量 ${name}` };
  }

  // 4. 凭据文件里的固定名字。
  for (const name of names) {
    const hit = resolveRef(name);
    if (hit !== undefined) return hit;
  }

  // 5. 官方 CLI 的登录态。
  const authFile = path.join(home, '.commandcode', 'auth.json');
  const authKey = readOfficialAuthFile(authFile);
  if (authKey !== undefined) return { key: authKey, source: authFile };

  throw new QuotaError(
    'MISSING_CREDENTIAL',
    '未找到 Command Code API key。把 Command Code 配成 DSH 的 provider（设置 → Models）即可自动识别，或设置 COMMANDCODE_API_KEY 环境变量。',
    // Nothing on this machine points at Command Code: the plugin is simply not
    // applicable here, and the caller hides the card instead of showing an
    // error. A discovered route with an unresolvable key stays `configured`.
    { configured: sawCommandCodeRoute },
  );
}

/** 把 HTTP 状态码归到一个稳定错误码上。 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'SERVICE';
  return 'HTTP_ERROR';
}

/**
 * 请求一个端点并解析 JSON。非 2xx 与不可解析的响应都返回 `undefined` 记录，
 * 只有传输层失败才抛出，供调用方按端点记账。
 *
 * @returns {Promise<{ status: number, record?: unknown }>}
 * @throws {QuotaError} 传输失败或超时，码为 `NETWORK`。
 */
async function getJson(url, headers, timeoutMs, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new QuotaError('NETWORK', `${url} 请求失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) return { status: response.status };
  try {
    return { status: response.status, record: await response.json() };
  } catch {
    // 拿到了 2xx 但不是 JSON：按 BAD_RESPONSE 记账，不冒充成功。
    throw new QuotaError('BAD_RESPONSE', `${url} 返回了非 JSON 响应`, { status: response.status });
  }
}

/** 把 `{used, cap, exceeded, resetAt}` 归一成窗口对象。 */
function parseWindow(block) {
  if (!isRecord(block)) return undefined;
  const used = numberOf(block.used);
  const cap = numberOf(block.cap);
  if (used === undefined && cap === undefined) return undefined;
  return {
    used: used ?? 0,
    cap: cap ?? 0,
    percent: cap !== undefined && cap > 0 ? Math.min(100, ((used ?? 0) / cap) * 100) : undefined,
    exceeded: block.exceeded === true,
    resetAt: numberOf(block.resetAt),
  };
}

/**
 * Nominal span of each rolling window. The API reports when a window resets but
 * not when it opened, and Command Code's windows roll from first use, so the
 * open instant is the reset minus this span.
 */
const WINDOW_SPAN_MS = Object.freeze({
  fiveHour: 5 * 3_600_000,
  weekly: 7 * 86_400_000,
});

/**
 * Compare how much of a window is spent against how much of it has elapsed.
 *
 * This is deliberately preferred over extrapolating a rate: credit burn is
 * bursty, so a projected exhaustion time swings wildly, while two cumulative
 * shares measured over the same window stay comparable. `state` answers the
 * only question that matters — at this pace, does the window run out before it
 * resets?
 *
 * @param percent - used percentage, or undefined when the host reported none.
 * @param start - window open instant in epoch milliseconds.
 * @param end - window reset instant in epoch milliseconds.
 * @param now - current instant, injected so callers and tests agree.
 * @returns the pace block, or undefined when either instant is unusable.
 */
function paceOf(percent, start, end, now) {
  if (percent === undefined || start === undefined || end === undefined) return undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  const raw = ((now - start) / (end - start)) * 100;
  if (!Number.isFinite(raw)) return undefined;
  const elapsedPercent = Math.max(0, Math.min(100, raw));
  const delta = percent - elapsedPercent;
  return {
    elapsedPercent,
    delta,
    state: delta > 10 ? 'over' : delta < -10 ? 'under' : 'on',
  };
}

/**
 * 拉取并归一化一个账号的完整额度报告。
 *
 * 四个端点各自独立降级：单个端点失败只记进 `failures`，其余照常返回，因此一次
 * 抖动不会让整个视图变空。四个全失败时抛错，并带上最具体的错误码。
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] 显式密钥；省略则按 {@link resolveApiKey} 的优先级解析。
 * @param {string} [options.apiBase] API 基地址，默认 {@link DEFAULT_API_BASE}。
 * @param {number} [options.timeoutMs] 单端点超时。
 * @param {typeof fetch} [options.fetchImpl] 注入 fetch，便于测试。
 * @param {NodeJS.ProcessEnv} [options.env] 传给密钥解析的环境变量表。
 * @param {string} [options.home] 用户主目录。
 * @param {string} [options.dshHome] DSH 数据目录。
 * @returns {Promise<object>} 报告对象，字段见 README。
 */
export async function fetchQuotaReport(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolved = resolveApiKey(options);
  // An explicit base wins; otherwise follow the baseURL the user configured for
  // this route (it may be a proxy), falling back to the official host.
  const apiBase = (options.apiBase ?? resolved.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');

  const headers = {
    Authorization: `Bearer ${resolved.key}`,
    'x-command-code-version': CLI_VERSION,
    'x-cli-environment': 'production',
    'User-Agent': `commandcode-quota/${CLI_VERSION}`,
  };

  /** @type {string[]} */
  const failures = [];
  /** @type {number[]} */
  const failedStatuses = [];

  const get = async (url) => {
    try {
      const { status, record } = await getJson(url, headers, timeoutMs, fetchImpl);
      if (record === undefined) {
        failures.push(`${url.replace(apiBase, '')}: HTTP ${status}`);
        failedStatuses.push(status);
        return undefined;
      }
      return record;
    } catch (error) {
      failures.push(`${url.replace(apiBase, '')}: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof QuotaError && error.status !== undefined) failedStatuses.push(error.status);
      return undefined;
    }
  };

  const whoami = await get(`${apiBase}${ENDPOINTS.whoami}`);
  const orgId = isRecord(whoami) && isRecord(whoami.org) ? stringOf(whoami.org.id) : undefined;
  const subscriptionUrl =
    orgId === undefined
      ? `${apiBase}${ENDPOINTS.subscription}`
      : `${apiBase}${ENDPOINTS.subscription}?orgId=${encodeURIComponent(orgId)}`;

  const [usage, credits, subscription] = await Promise.all([
    get(`${apiBase}${ENDPOINTS.usage}`),
    get(`${apiBase}${ENDPOINTS.credits}`),
    get(subscriptionUrl),
  ]);

  const requestCount = failures.length;
  if (requestCount === 4) {
    const codes = failedStatuses;
    if (codes.length === 4 && codes.every((status) => status === 401 || status === 403)) {
      throw new QuotaError('AUTH', 'API key 被拒绝（401）：key 是否已失效或被重置？', { failures });
    }
    if (codes.length === 4 && codes.every((status) => status >= 500)) {
      throw new QuotaError('SERVICE', 'Command Code 服务端异常（5xx），稍后重试。', { failures });
    }
    throw new QuotaError('NETWORK', `四个端点全部失败：\n  ${failures.join('\n  ')}`, { failures });
  }

  const user = isRecord(whoami) && isRecord(whoami.user) ? whoami.user : undefined;
  const creditData = isRecord(credits) && isRecord(credits.credits) ? credits.credits : undefined;
  const windowLimits = isRecord(credits) && isRecord(credits.windowLimits) ? credits.windowLimits : undefined;
  const subData = isRecord(subscription) && isRecord(subscription.data) ? subscription.data : undefined;

  const planId = stringOf(subData?.planId) ?? stringOf(creditData?.planId);
  const planInfo = subscriptionPlanInfo(planId);

  const usedCredits = numberOf(usage?.totalCredits);
  const remainingCredits = numberOf(creditData?.monthlyCredits);
  const monthlyCap =
    usedCredits !== undefined && remainingCredits !== undefined
      ? usedCredits + remainingCredits
      : (planInfo?.monthlyCredits ?? undefined);

  const currentPeriodStart = stringOf(subData?.currentPeriodStart);
  const currentPeriodEnd = stringOf(subData?.currentPeriodEnd);
  const now = Date.now();

  /** Attach a pace block to one rolling window, deriving its open instant from its reset. */
  const withPace = (window, spanMs) => {
    if (window === undefined) return undefined;
    const resetAt = window.resetAt;
    return {
      ...window,
      pace:
        resetAt === undefined || spanMs === undefined
          ? undefined
          : paceOf(window.percent, resetAt - spanMs, resetAt, now),
    };
  };

  const monthlyPace = paceOf(
    monthlyCap !== undefined && monthlyCap > 0 && usedCredits !== undefined
      ? Math.min(100, (usedCredits / monthlyCap) * 100)
      : undefined,
    currentPeriodStart === undefined ? undefined : Date.parse(currentPeriodStart),
    currentPeriodEnd === undefined ? undefined : Date.parse(currentPeriodEnd),
    now,
  );

  let projection;
  if (
    usedCredits !== undefined &&
    remainingCredits !== undefined &&
    currentPeriodStart !== undefined &&
    currentPeriodEnd !== undefined
  ) {
    const start = Date.parse(currentPeriodStart);
    const end = Date.parse(currentPeriodEnd);
    const elapsedDays = (Date.now() - start) / 86_400_000;
    if (Number.isFinite(elapsedDays) && elapsedDays > 0) {
      const dailyRate = usedCredits / elapsedDays;
      projection = {
        elapsedDays,
        totalDays: (end - start) / 86_400_000,
        dailyRate,
        runsOutInDays: dailyRate > 0 ? remainingCredits / dailyRate : undefined,
      };
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    apiBase,
    credentialSource: resolved.source,
    account:
      user === undefined
        ? undefined
        : { id: stringOf(user.id), name: stringOf(user.name), userName: stringOf(user.userName), orgId },
    plan:
      planId === undefined
        ? undefined
        : {
            planId,
            name: planInfo?.name ?? planId,
            nominalMonthlyCredits: planInfo?.monthlyCredits,
            status: stringOf(subData?.status),
            currentPeriodStart,
            currentPeriodEnd,
            cancelAtPeriodEnd: subData?.cancelAtPeriodEnd === true,
            canceledAt: stringOf(subData?.canceledAt),
          },
    monthly: {
      used: usedCredits,
      remaining: remainingCredits,
      cap: monthlyCap,
      percent:
        usedCredits !== undefined && monthlyCap !== undefined && monthlyCap > 0
          ? Math.min(100, (usedCredits / monthlyCap) * 100)
          : undefined,
      freeCredits: numberOf(creditData?.freeCredits),
      purchasedCredits: numberOf(creditData?.purchasedCredits),
      belowThreshold: creditData?.belowThreshold === true,
      creditThreshold: numberOf(creditData?.creditThreshold),
      periodBasis: stringOf(usage?.periodBasis),
      pace: monthlyPace,
    },
    fiveHour: withPace(parseWindow(windowLimits?.fiveHour), WINDOW_SPAN_MS.fiveHour),
    weekly: withPace(parseWindow(windowLimits?.weekly), WINDOW_SPAN_MS.weekly),
    totals: {
      requests: numberOf(usage?.totalCount),
      successRate: numberOf(usage?.successRate),
      completed: numberOf(usage?.completedCount),
      failed: numberOf(usage?.failedCount),
      tokensIn: numberOf(usage?.totalTokensIn),
      tokensOut: numberOf(usage?.totalTokensOut),
    },
    projection,
    failures,
  };
}
