// 本仓测试：只把自身包名映射到源码；@silkor/* 走 npm 安装的正式版本。
// 正式版本的 dist 是「无扩展名的相对导入」，Node 原生 ESM 无法解析，
// 这里让 vitest 内联 @silkor/* 交给 Vite 解析，等价于宿主打包器的行为。
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@silkor/mindmap": resolve(root, "src/index.ts") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    server: { deps: { inline: [/@silkor\//] } },
  },
});
