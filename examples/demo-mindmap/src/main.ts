// 入口：挂载 canvas 并渲染一张示例思维导图
import { MindMap, type MindMapNode, type Style } from "@silker/mindmap";

// 统一样式：所有节点共用，按需用展开覆盖差异字段
const style: Style = {
  color: "#1f2937",
  backgroundColor: "#ffffff",
  fontSize: 16,
  fontWeight: 400,
  fontFamily: "sans-serif",
  radius: 6,
  borderColor: "#60a5fa",
  borderWidth: 0,
  lineHeight: 1.4,
  padding: [6, 12],
};

const data: MindMapNode = {
  text: "中心主题",
  style: { ...style, fontSize: 16, fontWeight: 200 },
  children: [
    {
      text: "前端",
      style: { ...style, backgroundColor: "#eff6ff" },
      children: [
        {
          text: "框架",
          style,
          children: [
            { text: "React", style, children: [] },
            { text: "Vue", style, children: [] },
            { text: "Svelte", style, children: [] },
          ],
        },
        {
          text: "构建工具",
          style,
          children: [
            { text: "Vite", style, children: [] },
            { text: "Webpack", style, children: [] },
          ],
        },
        {
          text: "样式方案",
          style,
          children: [
            { text: "Tailwind", style, children: [] },
            { text: "CSS Modules", style, children: [] },
          ],
        },
      ],
    },
    {
      text: "后端",
      style: { ...style, backgroundColor: "#f0fdf4" },
      children: [
        {
          text: "Node.js",
          style,
          children: [
            { text: "Express", style, children: [] },
            { text: "NestJS", style, children: [] },
          ],
        },
        {
          text: "数据库",
          style,
          children: [
            { text: "MySQL", style, children: [] },
            { text: "PostgreSQL", style, children: [] },
            { text: "Redis", style, children: [] },
          ],
        },
        {
          text: "API 设计",
          style,
          children: [
            { text: "REST", style, children: [] },
            { text: "GraphQL", style, children: [] },
          ],
        },
      ],
    },
    {
      text: "运维",
      style: { ...style, backgroundColor: "#fefce8" },
      children: [
        {
          text: "容器化",
          style,
          children: [
            { text: "Docker", style, children: [] },
            { text: "K8s", style, children: [] },
          ],
        },
        {
          text: "CI/CD",
          style,
          children: [
            { text: "GitHub Actions", style, children: [] },
            { text: "Jenkins", style, children: [] },
          ],
        },
      ],
    },
    {
      text: "测试",
      style: { ...style, backgroundColor: "#fef2f2" },
      children: [
        {
          text: "单元测试",
          style,
          children: [
            { text: "Vitest", style, children: [] },
            { text: "Jest", style, children: [] },
          ],
        },
        {
          text: "E2E 测试",
          style,
          children: [
            { text: "Playwright", style, children: [] },
            { text: "Cypress", style, children: [] },
          ],
        },
      ],
    },
  ],
};

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const mindmap = new MindMap({ canvas, data, direction: "right" });
mindmap.app.render();
