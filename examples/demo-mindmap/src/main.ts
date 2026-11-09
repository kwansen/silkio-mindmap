// 入口：挂载 canvas 并渲染一张示例思维导图
import { App, type EdgeShape } from "@silker/core";
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
    backgroundColor: "#d7dee6ff",
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
// 连线样式初始值：'bezier' 纯贝塞尔 S 曲线（默认），'path' Z 字折线，
// 'zBezier' Z 字贝塞尔，'rPath' 圆角 Z 字折线；运行时经 setEdgeStyle 原地设置
const edgeStyle: EdgeShape = "rPath";

// 显式装配：自建 App 并安装官方插件预设（集合与顺序的单一事实来源在 @silker/preset），
// MindMap 按能力键复用这些能力，只补齐自有的布局插件。
// App 与官方插件在布局切换时复用，MindMap 场景实例内经 setLayout 原地设置方向
const app = new App(canvas);
for (const p of officialPlugins()) app.use(p);

// 撤销/重做工具条：点击触发对应操作，按历史栈可用性禁用按钮（含 undo/redo 后刷新）
const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement;
const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement;
const directionSelect = document.getElementById(
  "direction-select",
) as HTMLSelectElement;
const edgeSelect = document.getElementById("edge-select") as HTMLSelectElement;

let mindmap!: MindMap;
const refreshToolbar = () => {
  undoBtn.disabled = !mindmap.canUndo;
  redoBtn.disabled = !mindmap.canRedo;
};

// 创建 MindMap 场景实例（布局切换走 setLayout，实例与数据保持不动）
function createMindmap(direction: "left" | "right" | "down" | "both") {
  mindmap = new MindMap({
    app,
    data,
    direction,
    levelStyles,
    edgeStyle,
    // 数据变化（新增/删除/移动/文本编辑）时打印当前数据 JSON
    onChange: (type) => {
      console.log(
        `[MindMap] ${type}`,
        JSON.stringify(mindmap.toJSON(), null, 2),
      );
      refreshToolbar();
    },
  });
  refreshToolbar();
}

// 布局方向设置：横向思维导图（right）/ 左向思维导图（left）/ 双向平衡布局（both）/ 组织结构图（down）
// 同一实例原地设置：数据、选中态、撤销栈均保留
directionSelect.addEventListener("change", () => {
  void mindmap.setLayout(
    directionSelect.value as "left" | "right" | "down" | "both",
  );
});
// 连线形状设置：同一实例原地重建连线，数据、选中态、撤销栈均保留
edgeSelect.value = edgeStyle;
edgeSelect.addEventListener("change", () => {
  mindmap.setEdgeStyle(edgeSelect.value as EdgeShape);
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

// 缩放滑块：拖动以画布中心为锚点缩放，范围与滚轮缩放一致（0.2–8）；
// 滚轮/插件触发的视口变化经 camera.onViewportChange 回写滑块，双向同步
const zoomSlider = document.getElementById("zoom-slider") as HTMLInputElement;
const zoomValue = document.getElementById("zoom-value") as HTMLSpanElement;

const updateZoomUI = (scale: number) => {
  zoomSlider.value = String(Math.round(scale * 100));
  zoomValue.textContent = `${Math.round(scale * 100)}%`;
};

zoomSlider.addEventListener("input", () => {
  const scale = Number(zoomSlider.value) / 100;
  const vp = app.camera.viewport;
  const rect = canvas.getBoundingClientRect();
  // 画布中心的世界坐标在缩放前后保持不动
  const wx = (rect.width / 2 - vp.x) / vp.scale;
  const wy = (rect.height / 2 - vp.y) / vp.scale;
  app.camera.setViewport({
    x: rect.width / 2 - wx * scale,
    y: rect.height / 2 - wy * scale,
    scale,
  });
  // setViewport 只更新相机状态，需显式触发相机-only 重渲染（与滚轮缩放一致）
  app.requestCameraRender();
});

// 滚轮等外部视口变化 → 同步滑块与百分比显示
app.camera.onViewportChange(() => {
  updateZoomUI(app.camera.scale);
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
