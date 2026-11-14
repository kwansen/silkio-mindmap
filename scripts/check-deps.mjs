// mindmap 仓架构守护（由原 monorepo 的 scripts/check-deps.mjs 拆分而来）
// 1. 只允许依赖 @silkor/core / @silkor/preset / @silkor/mindmap
// 2. 禁止直接依赖 @silkor/plugin-*：官方插件清单以 @silkor/preset 为单一事实来源
// 3. 禁止依赖另一个场景仓 @silkor/flowchart（两个场景必须彼此独立）
// 4. 所有 import 的 @silkor/* 包必须显式声明在 dependencies / devDependencies
// 用法：pnpm check:deps
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const errors = [];
const PKG = "@silkor/mindmap";
const OTHER_PKG = "@silkor/flowchart";
const ALLOWED = new Set(["@silkor/core", "@silkor/preset", PKG]);
const SOURCE_EXTS = new Set([".ts", ".tsx", ".vue", ".js", ".mjs", ".astro"]);
const SKIP = new Set(["node_modules", "dist", ".astro", ".git"]);
const IMPORT_RE = /from\s+['"](@silkor\/[^'"]+)['"]/g;

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (SOURCE_EXTS.has(extname(entry.name))) out.push(p);
  }
  return out;
}

const units = [{ dir: root, label: PKG, skip: new Set(["examples", "scripts", ".github", ...SKIP]) }];
const examplesDir = join(root, "examples");
if (existsSync(examplesDir)) {
  for (const name of readdirSync(examplesDir)) {
    const dir = join(examplesDir, name);
    if (existsSync(join(dir, "package.json"))) units.push({ dir, label: name, skip: SKIP });
  }
}

for (const unit of units) {
  const pkgJson = JSON.parse(readFileSync(join(unit.dir, "package.json"), "utf8"));
  const declared = new Set(
    [...Object.keys(pkgJson.dependencies ?? {}), ...Object.keys(pkgJson.devDependencies ?? {})]
      .filter((d) => d.startsWith("@silkor/")),
  );

  for (const d of declared) {
    if (!ALLOWED.has(d)) {
      errors.push(`${unit.label}: 不允许依赖 "${d}"（只允许 @silkor/core / @silkor/preset / ${PKG}）`);
    }
    if (d === OTHER_PKG || d.startsWith("@silkor/plugin-")) {
      errors.push(`${unit.label}: 禁止依赖 "${d}"（场景仓彼此独立；插件请通过 @silkor/preset 装配）`);
    }
  }

  const files = [];
  for (const entry of readdirSync(unit.dir, { withFileTypes: true })) {
    if (unit.skip.has(entry.name)) continue;
    const p = join(unit.dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(p));
    else if (SOURCE_EXTS.has(extname(entry.name))) files.push(p);
  }

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const dep = m[1];
      if (dep === PKG) continue;
      if (!declared.has(dep)) {
        errors.push(`${relative(root, file)}: import 了未声明的依赖 "${dep}"`);
      }
    }
  }
}

if (errors.length) {
  console.error("依赖规则检查未通过：\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log("依赖规则检查通过：mindmap 场景仓边界与声明一致性 OK");
