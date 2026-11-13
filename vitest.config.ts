// 本仓测试：只把自身包名映射到源码；跨仓依赖走 node_modules（父开发目录下会链接到源码）。
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@silker/mindmap": resolve(root, "src/index.ts") },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
