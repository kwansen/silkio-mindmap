// 入口：挂载 canvas 并渲染一张示例思维导图
import { MindMap, type Style } from "@silker/mindmap";

// 级数样式配置：index 0 为根节点（一级），依次向深层级递增，超出配置长度套用最后一项
const levelStyles: Style[] = [
  // 一级样式：根节点
  {
    color: "#ffffff",
    backgroundColor: "#3b82f6",
    fontSize: 24,
    fontWeight: 500,
    fontFamily: "sans-serif",
    radius: 6,
    borderColor: "#60a5fa",
    borderWidth: 0,
    lineHeight: 1.4,
    padding: [8, 24],
  },
  // 二级样式：分支节点
  {
    color: "#1f2937",
    backgroundColor: "#eff6ff",
    fontSize: 16,
    fontWeight: 500,
    fontFamily: "sans-serif",
    radius: 6,
    borderColor: "",
    borderWidth: 0,
    lineHeight: 1.4,
    padding: [6, 16],
  },
  // 三级及以后样式（叶子节点）
  {
    color: "#1f2937",
    backgroundColor: "",
    fontSize: 14,
    fontWeight: 400,
    fontFamily: "sans-serif",
    radius: 6,
    borderColor: "",
    borderWidth: 0,
    lineHeight: 1.4,
    padding: [6, 12],
  },
];

// 用户数据：节点上的 style 可覆盖级数配置，缺省时按级数取 levelStyles
const data = {
  text: "中心主题",
  children: [
    {
      text: "前端",
      children: [
        {
          text: "框架",
          children: [
            { text: "React", children: [] },
            { text: "Vue", children: [] },
            { text: "Svelte", children: [] },
          ],
        },
        {
          text: "构建工具",
          children: [
            { text: "Vite", children: [] },
            { text: "Webpack", children: [] },
          ],
        },
        {
          text: "样式方案",
          children: [
            { text: "Tailwind", children: [] },
            { text: "CSS Modules", children: [] },
          ],
        },
      ],
    },
    {
      text: "后端",
      children: [
        {
          text: "Node.js",
          children: [
            { text: "Express", children: [] },
            { text: "NestJS", children: [] },
          ],
        },
        {
          text: "数据库",
          children: [
            { text: "MySQL", children: [] },
            { text: "PostgreSQL", children: [] },
            { text: "Redis", children: [] },
          ],
        },
        {
          text: "API 设计",
          children: [
            { text: "REST", children: [] },
            { text: "GraphQL", children: [] },
          ],
        },
      ],
    },
    {
      text: "运维",
      children: [
        {
          text: "容器化",
          children: [
            { text: "Docker", children: [] },
            { text: "K8s", children: [] },
          ],
        },
        {
          text: "CI/CD",
          children: [
            { text: "GitHub Actions", children: [] },
            { text: "Jenkins", children: [] },
          ],
        },
      ],
    },
    {
      text: "测试",
      children: [
        {
          text: "单元测试",
          children: [
            { text: "Vitest", children: [] },
            { text: "Jest", children: [] },
          ],
        },
        {
          text: "E2E 测试",
          children: [
            { text: "Playwright", children: [] },
            { text: "Cypress", children: [] },
          ],
        },
      ],
    },
  ],
};

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const mindmap = new MindMap({ canvas, data, direction: "right", levelStyles });
mindmap.app.render();
