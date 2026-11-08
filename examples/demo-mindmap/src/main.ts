// 入口：挂载 canvas 并渲染一张示例思维导图
import { App } from "@silker/core";
import { officialPlugins } from "@silker/preset";
import { MindMap, type Style } from "@silker/mindmap";

// 级数样式配置：index 0 为根节点（一级），依次向深层级递增，超出配置长度套用最后一项
const levelStyles: Style[] = [
  // 一级样式：根节点
  {
    color: "#ffffffff",
    backgroundColor: "#435465",
    fontSize: 24,
    fontWeight: 500,
    fontFamily: "sans-serif",
    radius: 6,
    borderColor: "",
    borderWidth: 0,
    lineHeight: 1.4,
    padding: [8, 24],
  },
  // 二级样式：分支节点
  {
    color: "#1f2937",
    backgroundColor: "#C0CAD5",
    fontSize: 16,
    fontWeight: 500,
    fontFamily: "sans-serif",
    radius: 6,
    borderColor: "",
    borderWidth: 0,
    lineHeight: 1.4,
    padding: [6, 16],
  },
  // 三级样式
  {
    color: "#1f2937",
    backgroundColor: "#f2f2f2ff",
    fontSize: 14,
    fontWeight: 400,
    fontFamily: "sans-serif",
    radius: 6,
    borderColor: "",
    borderWidth: 0,
    lineHeight: 1.4,
    padding: [6, 12],
  },
  // 四级及以后样式（叶子节点）
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
        { text: "React", children: [] },
        { text: "Vue", children: [] },
      ],
    },
    {
      text: "后端",
      children: [
        { text: "Node.js", children: [] },
        { text: "数据库", children: [{ text: "MySQL", children: [] }] },
      ],
    },
    {
      text: "运维",
      children: [
        { text: "Docker", children: [] },
        { text: "K8s", children: [] },
      ],
    },
    {
      text: "测试",
      children: [{ text: "Vitest", children: [] }],
    },
  ],
  // 更多示例（取消注释可替换上方 children 观察 deeper 布局）：
  // {
  //   text: "前端",
  //   children: [
  //     {
  //       text: "框架",
  //       children: [
  //         { text: "React", children: [] },
  //         { text: "Vue", children: [] },
  //         { text: "Svelte", children: [] },
  //       ],
  //     },
  //     {
  //       text: "构建工具",
  //       children: [
  //         { text: "Vite", children: [] },
  //         { text: "Webpack", children: [] },
  //       ],
  //     },
    //     {
    //       text: "样式方案",
    //       children: [
    //         { text: "Tailwind", children: [] },
    //         { text: "CSS Modules", children: [] },
    //       ],
    //     },
    //   ],
    // },
    // {
    //   text: "后端",
    //   children: [
    //     {
    //       text: "Node.js",
    //       children: [
    //         { text: "Express", children: [] },
    //         { text: "NestJS", children: [] },
    //       ],
    //     },
    //     {
    //       text: "数据库",
    //       children: [
    //         { text: "MySQL", children: [] },
    //         { text: "PostgreSQL", children: [] },
    //         { text: "Redis", children: [] },
    //       ],
    //     },
    //     {
    //       text: "API 设计",
    //       children: [
    //         { text: "REST", children: [] },
    //         { text: "GraphQL", children: [] },
    //       ],
    //     },
    //   ],
    // },
    // {
    //   text: "运维",
    //   children: [
    //     {
    //       text: "容器化",
    //       children: [
    //         { text: "Docker", children: [] },
    //         { text: "K8s", children: [] },
    //       ],
    //     },
    //     {
    //       text: "CI/CD",
    //       children: [
    //         { text: "GitHub Actions", children: [] },
    //         { text: "Jenkins", children: [] },
    //       ],
    //     },
    //   ],
    // },
    // {
    //   text: "测试",
    //   children: [
    //     {
    //       text: "单元测试",
    //       children: [
    //         { text: "Vitest", children: [] },
    //         { text: "Jest", children: [] },
    //       ],
    //     },
    //     {
    //       text: "E2E 测试",
    //       children: [
    //         { text: "Playwright", children: [] },
    //         { text: "Cypress", children: [] },
    //       ],
    //     },
    //   ],
    // },
};

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
// 连线样式参数：'bezier' 纯贝塞尔 S 曲线（默认），'path' Z 字折线，'rPath' 圆角 Z 字折线
const edgeStyle: "bezier" | "path" | "zBezier" | "rPath" = "rPath";

// 显式装配：自建 App 并安装官方插件预设（集合与顺序的单一事实来源在 @silker/preset），
// MindMap 按能力键复用这些能力，只补齐自有的布局插件。
// App 与官方插件在布局切换时复用，MindMap 场景实例内经 toggleLayout 原地切换方向
const app = new App(canvas);
for (const p of officialPlugins()) app.use(p);

// 撤销/重做工具条：点击触发对应操作，按历史栈可用性禁用按钮（含 undo/redo 后刷新）
const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement;
const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement;
const directionSelect = document.getElementById(
  "direction-select",
) as HTMLSelectElement;

let mindmap!: MindMap;
const refreshToolbar = () => {
  undoBtn.disabled = !mindmap.canUndo;
  redoBtn.disabled = !mindmap.canRedo;
};

// 创建 MindMap 场景实例（布局切换走 toggleLayout，实例与数据保持不动）
function createMindmap(direction: "left" | "right" | "down" | "both") {
  mindmap = new MindMap({
    app,
    data,
    direction,
    levelStyles,
    edgeStyle,
    // 数据变化（新增/删除/移动/文本编辑）时打印当前数据 JSON
    onChange: (type) => {
      console.log(`[MindMap] ${type}`, JSON.stringify(mindmap.toJSON(), null, 2));
      refreshToolbar();
    },
  });
  refreshToolbar();
}

// 布局方向切换：横向思维导图（right）/ 左向思维导图（left）/ 双向平衡布局（both）/ 组织结构图（down）
// 同一实例原地切换：数据、选中态、撤销栈均保留
directionSelect.addEventListener("change", () => {
  void mindmap.toggleLayout(directionSelect.value as "left" | "right" | "down" | "both");
});
createMindmap("right");

undoBtn.addEventListener("click", async () => {
  await mindmap.undo();
  refreshToolbar();
});
redoBtn.addEventListener("click", async () => {
  await mindmap.redo();
  refreshToolbar();
});

// 导出图片：整棵树离屏渲染为 PNG 并触发下载
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
exportBtn.addEventListener("click", async () => {
  const blob = await mindmap.toImage();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mindmap.png";
  a.click();
  URL.revokeObjectURL(url);
});
// 初始渲染由 MindMap 异步 init 完成后自行触发（requestRender），无需外部渲染
refreshToolbar();
// 临时调试：暴露实例供浏览器自动化测试定位节点（验证后移除）
(window as any).__mindmap = mindmap;
