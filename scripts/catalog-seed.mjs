#!/usr/bin/env node
/**
 * 内置基线 `catalog.seed.json` 的生成与校验。
 *
 *    node scripts/catalog-seed.mjs --write             联网抓一次，写入 seed
 *    node scripts/catalog-seed.mjs --from <dir>        用本地保存的 .rsc 生成（离线）
 *    node scripts/catalog-seed.mjs --check             离线自洽校验（CI 用）
 *
 * 为什么要有 seed：用户第一次装插件、或者机器离线/被墙时，设置面板不该是空白。
 * seed 只装**解析结果**（数字 + 复算所需的输入 + 来源 URL），不装上游正文。
 *
 * `--check` 不联网也能抓到「口径漂移」：seed 里每个模型都存了 `budgetUsd`、
 * `rates`、`shape`，用当前公式重算必须与存下来的次数一致。谁改了公式或解析口径
 * 却没重生成 seed，这里就会红 —— 这正是「改了实现要同步产物」的那条规矩。
 *
 * 退出码：0 正常；1 校验不通过；2 用法错误。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_KIND,
  CATALOG_SCHEMA,
  CATALOG_VERSION,
  PLAN_DOC_URLS,
  PRICING_DOC_URL,
  catalogSeedPath,
  computeAllowance,
  parsePlanCatalog,
  parsePricingCatalog,
  readCatalogSeed,
  syncCatalog,
} from '../catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const seedFile = catalogSeedPath();

/** 有官方专页的档位（ultra 按 Max 推断，也进 seed，让 Ultra 用户离线也有数）。 */
const PLANS_WITH_DOCS = Object.keys(PLAN_DOC_URLS).filter((planId) => PLAN_DOC_URLS[planId] !== undefined);

/**
 * seed 体积上限：超过说明有人把上游正文也塞进来了。
 *
 * 现为 384 KB：加入「按官方 provider 默认形状推算」与「免费」两类模型后，每个模型
 * 要带上复算所需的 budgetUsd / rates / shape，体积从 241 KB 涨到约 280 KB。
 * 这份文件只装解析结果，不装页面正文。
 */
const MAX_SEED_BYTES = 384 * 1024;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

/** 组装一份 seed（去掉运行时字段，保留校验器，让首次核对能直接命中「没变」）。 */
function buildSeed(catalog, at) {
  return {
    kind: CATALOG_KIND,
    version: CATALOG_VERSION,
    schema: CATALOG_SCHEMA,
    updatedAt: catalog.updatedAt ?? at,
    checkedAt: catalog.checkedAt ?? at,
    fetchMode: catalog.fetchMode ?? 'etag',
    bundledAt: at,
    plans: catalog.plans ?? {},
    pricing: catalog.pricing,
    planLevel: catalog.planLevel,
    validators: catalog.validators ?? {},
    // seed 里不带失败：它代表「发布那一刻的官方数据」，不是一次核对的结果。
    failures: [],
  };
}

/** 用本地保存的 .rsc 文件（--from <dir>）离线生成。 */
function buildFromDirectory(dir, now) {
  const read = (name) => {
    const file = path.join(dir, name);
    if (!existsSync(file)) throw new Error(`缺少 ${file}`);
    return readFileSync(file, 'utf8');
  };
  const pricingText = read('pricing.rsc');
  const pricing = parsePricingCatalog(pricingText);
  if ('error' in pricing) throw new Error(`定价页解析失败：${pricing.error.message}`);
  const plans = {};
  for (const planId of PLANS_WITH_DOCS) {
    const slug = path.basename(new URL(PLAN_DOC_URLS[planId].url).pathname);
    const parsed = parsePlanCatalog(planId, read(`${slug}.rsc`), { now, availability: pricing.models });
    if ('error' in parsed) throw new Error(`${planId} 解析失败：${parsed.error.message}`);
    plans[planId] = { ...parsed.entry, fetchedAt: new Date(now).toISOString() };
  }
  const at = new Date(now).toISOString();
  return buildSeed({
    updatedAt: at,
    checkedAt: at,
    plans,
    pricing: { models: pricing.models, fetchedAt: at },
    planLevel: { rows: pricing.planLevel, fetchedAt: at, sourceUrl: PRICING_DOC_URL },
  }, at);
}

/** 离线自洽校验：seed 必须能用自己的输入算出自己的输出。 */
function checkSeed() {
  const problems = [];
  if (!existsSync(seedFile)) {
    console.error(`seed 不存在：${seedFile}`);
    console.error('跑 `node scripts/catalog-seed.mjs --write` 生成。');
    return 1;
  }
  const bytes = readFileSync(seedFile);
  if (bytes.length > MAX_SEED_BYTES) {
    problems.push(`seed 体积 ${bytes.length} 字节，超过上限 ${MAX_SEED_BYTES}`);
  }
  const seed = readCatalogSeed({ file: seedFile });
  if (seed === undefined) {
    problems.push('seed 无法解析（kind/version/schema 不匹配）—— 口径变了就要重新生成');
    report(problems, 0);
    return 1;
  }
  let models = 0;
  for (const [planId, entry] of Object.entries(seed.plans ?? {})) {
    const rows = Array.isArray(entry?.models) ? entry.models : [];
    const withNumbers = rows.filter((model) => model?.source === 'plan-doc');
    if (withNumbers.length === 0) problems.push(`${planId}: 没有任何带次数的模型`);
    if (typeof entry?.fractions?.fiveHourFraction !== 'number' || typeof entry?.fractions?.weeklyFraction !== 'number') {
      problems.push(`${planId}: 缺窗口系数`);
    }
    for (const model of withNumbers) {
      models += 1;
      const recomputed = computeAllowance(
        { budgetUsd: model.budgetUsd, rates: model.rates, shape: model.shape },
        entry.fractions,
        Date.parse(seed.updatedAt ?? ''),
      );
      if (!sameNumber(recomputed.monthly, model.monthly)) {
        problems.push(`${planId}/${model.name}: 月次数 ${model.monthly} 与复算 ${recomputed.monthly} 不一致（公式或口径改了却没重生成 seed）`);
      }
      if (!sameNumber(recomputed.fiveHour, model.fiveHour) || !sameNumber(recomputed.week, model.week)) {
        problems.push(`${planId}/${model.name}: 窗口次数与复算不一致`);
      }
    }
  }
  if (models === 0) problems.push('seed 里一个带次数的模型都没有');
  if (!Array.isArray(seed.planLevel?.rows) || seed.planLevel.rows.length === 0) {
    problems.push('seed 缺套餐级概览表');
  }
  return report(problems, models);
}

/** 浮点比较：seed 里存的是同一个 double，序列化往返应当逐位相等。 */
function sameNumber(a, b) {
  if (a === b) return true;
  // JSON 没有 Infinity：免费模型（单价为 0 → 无限次）在 seed 里存成 null，
  // 由同一条目的 `free: true` 说明含义。
  if (a === null || b === null) {
    const other = a === null ? b : a;
    return typeof other === 'number' && !Number.isFinite(other);
  }
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) <= Math.abs(a) * 1e-12;
}

function report(problems, models) {
  if (problems.length > 0) {
    console.error(`seed 校验未通过（${problems.length} 项）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  const size = readFileSync(seedFile).length;
  console.log(`seed 校验通过：${Object.keys(readCatalogSeed({ file: seedFile }).plans ?? {}).length} 个档位、${models} 个带次数的模型、${size} 字节`);
  return 0;
}

if (has('--check')) {
  process.exit(checkSeed());
}

const from = valueOf('--from');
const now = Date.now();
let seed;
if (from !== undefined) {
  seed = buildFromDirectory(path.resolve(from), now);
} else if (has('--write')) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-quota-seed-'));
  const file = path.join(dir, 'catalog.json');
  try {
    const { catalog, failures } = await syncCatalog({
      planId: PLANS_WITH_DOCS[0],
      extraPlanIds: PLANS_WITH_DOCS,
      file,
      env: {},
    });
    if (failures.length > 0) {
      console.error('抓取有失败，不写 seed：');
      for (const failure of failures) console.error(`  - ${failure.code} ${failure.message}`);
      process.exit(1);
    }
    seed = buildSeed(catalog, new Date(now).toISOString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.error('用法：node scripts/catalog-seed.mjs --write | --from <dir> | --check');
  process.exit(2);
}

writeFileSync(seedFile, `${JSON.stringify(seed, null, 1)}\n`, 'utf8');
const size = readFileSync(seedFile).length;
console.log(`写入 ${path.relative(root, seedFile)}：${Object.keys(seed.plans).length} 个档位、${size} 字节`);
process.exit(0);
