#!/usr/bin/env node
/**
 * 一条命令给出整个仓库的结论。
 *
 *   node scripts/check.mjs            全部检查
 *   node scripts/check.mjs --quiet    每个套件只打一行
 *
 * CI 直接调这个文件，所以本地和线上是同一套判定——不会出现"本地过了 CI 挂"。
 * 不联网、不需要真实凭证：`dsh` 套件跑本仓库自己的 scripts/verify.mjs，
 * 它不启动 dsh，也不读真实账号（`--live` 才会，本脚本不传）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');

const suites = [];
const record = (name, fn) => suites.push({ name, fn });

/* ---------------------------------------------------------------- 工具 */

let failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.devdeps') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ------------------------------------------------------- 1. 全仓静态检查 */

record('static', () => {
  const files = walk(ROOT);
  let json = 0;
  let js = 0;

  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try { JSON.parse(fs.readFileSync(f, 'utf8')); json += 1; }
    catch (err) { assert(false, `JSON 非法: ${path.relative(ROOT, f)} — ${err.message}`); }
  }

  // 本仓库的代码全部过语法检查——没有"别人的既成代码"要跳过。
  for (const f of files) {
    if (!/\.(mjs|cjs|js)$/.test(f)) continue;
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 20_000 });
    assert(r.status === 0, `语法错误: ${path.relative(ROOT, f)}`);
    js += 1;
  }

  return `${json} 个 JSON + ${js} 个 JS`;
});

/* -------------------------------------------------------- 2. 密钥与隐私 */

record('secrets', () => {
  // 别让 API key、本机绝对路径或邮箱被提交进去——这是要公开发布的仓库。
  const patterns = [
    [/user_[A-Za-z0-9_-]{16,}/, 'Command Code key'],
    [/sk-[A-Za-z0-9]{20,}/, 'DeepSeek 风格 key'],
    [/ghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub PAT'],
    [/C:[\\/]Users[\\/][A-Za-z0-9._-]+/, '个人绝对路径'],
    [/\/Users\/[A-Za-z0-9._-]+/, 'macOS 个人绝对路径'],
    [/[A-Za-z0-9._%+-]+@(?!example\.com|users\.noreply)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '邮箱'],
  ];
  let scanned = 0;
  for (const f of walk(ROOT)) {
    if (/\.(png|jpg|ico|woff2?|lock)$/.test(f)) continue;
    // 本文件自己的规则里就写着这些形态，跳过它
    if (f === fileURLToPath(import.meta.url)) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const [re, label] of patterns) {
      const hit = text.match(re);
      if (hit) assert(false, `${label} 出现在 ${path.relative(ROOT, f)}: ${hit[0].slice(0, 24)}…`);
    }
    scanned += 1;
  }
  return `${scanned} 个文件已扫描`;
});

/* ---------------------------------------------------------- 3. 包身份 */

record('manifest', () => {
  // 包名同时是 cordis 的 loader id，改错了插件就装不上——用机器盯着它。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');

  assert(pkg.name === 'dsh-commandcode-quota', `package.json 的 name 变了: ${pkg.name}`);
  assert(pkg.version === lock.version, `package.json ${pkg.version} 与 package-lock.json ${lock.version} 不一致`);
  assert(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json 应声明 dsh.bundle.patch → ./cordis.patch.yml');
  assert(pkg.dsh?.client?.platform === 'web', 'package.json 应声明 dsh.client.platform === "web"');
  assert(pkg.exports?.['./client'] === './client.js', 'package.json 应导出 ./client → ./client.js');

  assert(patch.includes(`id: commandcode-quota`), 'cordis.patch.yml 里缺 loader 行');
  assert(patch.includes(`name: "${pkg.name}"`), `cordis.patch.yml 的 loader name 应等于包名 ${pkg.name}`);

  // 商店截图声明的每个文件都得真的在仓库里。
  const shots = JSON.parse(fs.readFileSync(path.join(ROOT, 'screenshots.json'), 'utf8'));
  assert(Array.isArray(shots) && shots.length > 0, 'screenshots.json 应是一个非空数组');
  for (const shot of shots) {
    assert(fs.existsSync(path.join(ROOT, shot)), `screenshots.json 指向的文件不存在: ${shot}`);
  }

  for (const file of ['README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE', 'SECURITY.md']) {
    assert(fs.existsSync(path.join(ROOT, file)), `缺少 ${file}`);
  }

  return `${pkg.name}@${pkg.version} · ${shots.length} 张截图`;
});

/* ------------------------------------------------------- 4. 本仓库的套件 */

record('dsh', () => {
  const devdeps = path.join(ROOT, '.devdeps', 'node_modules', 'react');
  if (!fs.existsSync(devdeps)) {
    return '跳过（未装 .devdeps 里的 react；见 README「Development」）';
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify.mjs'), '--quiet'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tail = out.trim().split('\n').slice(-3).join(' | ');
  assert(r.status === 0, `套件失败：${tail}`);
  return tail || '通过';
});

/* ------------------------------------------------------------ 执行 */

console.log('dsh-commandcode-quota — 仓库检查\n');
let failed = 0;

for (const { name, fn } of suites) {
  failures = [];
  const started = Date.now();
  let summary = '';
  try {
    summary = (await fn()) ?? '';
  } catch (err) {
    failures.push(`套件抛错：${err instanceof Error ? err.message : String(err)}`);
  }
  const ms = Date.now() - started;

  if (failures.length === 0) {
    console.log(`${QUIET ? '' : '  ok    '}${name.padEnd(10)} ${summary}  (${ms}ms)`);
  } else {
    failed += 1;
    console.log(`${QUIET ? '' : '  FAIL  '}${name.padEnd(10)} —  (${ms}ms)`);
    for (const f of failures) console.log(`          ${f}`);
  }
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 个套件失败。`);
  process.exit(1);
}
console.log(`${suites.length} 个套件全部通过。`);
