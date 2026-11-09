<script setup lang="ts">
// 思维导图 Demo：canvas + 胶囊工具条（撤销/重做、布局方向、连线形状、缩放）
import { onMounted, ref, type Component } from "vue";
import { App, type EdgeShape } from "@silker/core";
import { officialPlugins } from "@silker/preset";
import { MindMap, type Style } from "@silker/mindmap";
import Undo from "../icons/Undo.vue";
import Redo from "../icons/Redo.vue";
import LayoutRight from "../icons/LayoutRight.vue";
import LayoutLeft from "../icons/LayoutLeft.vue";
import LayoutBoth from "../icons/LayoutBoth.vue";
import LayoutDown from "../icons/LayoutDown.vue";
import EdgeBezier from "../icons/EdgeBezier.vue";
import EdgePath from "../icons/EdgePath.vue";
import EdgeRPath from "../icons/EdgeRPath.vue";

type LayoutDirection = "left" | "right" | "down" | "both";

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
};

// 工具条状态
const canvasRef = ref<HTMLCanvasElement | null>(null);
const layout = ref<LayoutDirection>("right");
const edge = ref<EdgeShape>("rPath");
const zoom = ref(100);
const canUndo = ref(false);
const canRedo = ref(false);

// 布局方向选项：value 同时是触发器图标 data-icon-value 与菜单项值
const layoutOptions: {
  value: LayoutDirection;
  short: string;
  title: string;
}[] = [
  { value: "right", short: "横向", title: "横向思维导图" },
  { value: "left", short: "左向", title: "左向思维导图" },
  { value: "both", short: "双向", title: "双向平衡布局" },
  { value: "down", short: "组织结构", title: "组织结构图" },
];

// 连线形状选项：'bezier' 纯贝塞尔 S 曲线，'path' Z 字折线，'rPath' 圆角 Z 字折线
const edgeOptions: { value: EdgeShape; short: string; title: string }[] = [
  { value: "bezier", short: "贝塞尔", title: "贝塞尔曲线" },
  { value: "path", short: "Z 折线", title: "Z 字折线" },
  { value: "rPath", short: "圆角折线", title: "圆角折线" },
];

// value → 图标组件映射：触发器与下拉菜单复用同一套图标
const layoutIcons: Record<LayoutDirection, Component> = {
  right: LayoutRight,
  left: LayoutLeft,
  both: LayoutBoth,
  down: LayoutDown,
};

const edgeIcons: Record<EdgeShape, Component> = {
  bezier: EdgeBezier,
  path: EdgePath,
  rPath: EdgeRPath,
};

// 非 响应式实例：App/MindMap 内部状态复杂，不做深度代理，UI 状态经上面的 ref 单向同步
let app!: App;
let mindmap!: MindMap;

function syncToolbar() {
  canUndo.value = mindmap.canUndo;
  canRedo.value = mindmap.canRedo;
}

function pickLayout(value: LayoutDirection) {
  layout.value = value;
  // 同一实例原地设置：数据、选中态、撤销栈均保留
  void mindmap.setLayout(value);
}

function pickEdge(value: EdgeShape) {
  edge.value = value;
  // 同一实例原地重建连线，数据、选中态、撤销栈均保留
  mindmap.setEdgeStyle(value);
}

async function undo() {
  await mindmap.undo();
  syncToolbar();
}

async function redo() {
  await mindmap.redo();
  syncToolbar();
}

// 缩放滑块：以画布中心为锚点缩放，范围与滚轮缩放一致（0.2–8）
function onZoomInput(event: Event) {
  const scale = Number((event.target as HTMLInputElement).value) / 100;
  zoom.value = Math.round(scale * 100);
  const vp = app.camera.viewport;
  const rect = canvasRef.value!.getBoundingClientRect();
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
}

onMounted(() => {
  const canvas = canvasRef.value!;

  // 显式装配：自建 App 并安装官方插件预设（集合与顺序的单一事实来源在 @silker/preset），
  // MindMap 按能力键复用这些能力，只补齐自有的布局插件
  app = new App(canvas);
  for (const p of officialPlugins()) app.use(p);

  // 滚轮等外部视口变化 → 同步滑块与百分比显示
  app.camera.onViewportChange(() => {
    zoom.value = Math.round(app.camera.scale * 100);
  });

  // 创建 MindMap 场景实例；布局/连线切换走 setLayout/setEdgeStyle，实例与数据保持不动
  mindmap = new MindMap({
    app,
    data,
    direction: layout.value,
    levelStyles,
    edgeStyle: edge.value,
    // 数据变化（新增/删除/移动/文本编辑）时打印当前数据 JSON
    onChange: (type) => {
      console.log(
        `[MindMap] ${type}`,
        JSON.stringify(mindmap.toJSON(), null, 2),
      );
      syncToolbar();
    },
  });
  syncToolbar();

  // 临时调试：暴露实例供浏览器自动化测试定位节点（验证后移除）
  (window as any).__mindmap = mindmap;
});
</script>

<template>
  <canvas ref="canvasRef" class="block h-screen w-screen bg-white"></canvas>

  <!-- 单一胶囊工具条：撤销/重做可点击，其余项悬浮展开选项面板 -->
  <div
    class="fixed top-4 right-4 z-10 flex items-center gap-0.5 rounded-lg border border-gray-300 bg-white p-1 shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
  >
    <button
      class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
      :disabled="!canUndo"
      title="撤销"
      aria-label="撤销"
      @click="undo"
    >
      <Undo class="block h-4 w-4 shrink-0" />
    </button>
    <button
      class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
      :disabled="!canRedo"
      title="重做"
      aria-label="重做"
      @click="redo"
    >
      <Redo class="block h-4 w-4 shrink-0" />
    </button>

    <!-- 布局方向设置：横向（right）/ 左向（left）/ 双向平衡（both）/ 组织结构图（down） -->
    <div class="group relative">
      <button
        class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100"
        title="布局方向"
      >
        <component
          :is="layoutIcons[layout]"
          class="block h-4 w-4 shrink-0"
        />
      </button>
      <div
        class="absolute top-[calc(100%+10px)] right-0 z-20 hidden flex-col items-center gap-0.5 rounded-lg border border-gray-300 bg-white p-1 shadow-[0_4px_12px_rgba(0,0,0,0.1)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-[''] group-hover:flex"
      >
        <button
          v-for="opt in layoutOptions"
          :key="opt.value"
          class="flex h-14 w-14 cursor-pointer items-center justify-center rounded-md text-sm text-gray-500 hover:bg-gray-100"
          :class="{ 'bg-[#e5edff] text-blue-700': layout === opt.value }"
          :title="opt.title"
          @click="pickLayout(opt.value)"
        >
          <component :is="layoutIcons[opt.value]" class="h-9 w-9 shrink-0" />
        </button>
      </div>
    </div>

    <!-- 连线形状设置 -->
    <div class="group relative">
      <button
        class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100"
        title="连线形状"
      >
        <component :is="edgeIcons[edge]" class="block h-4 w-4 shrink-0" />
      </button>
      <div
        class="absolute top-[calc(100%+10px)] right-0 z-20 hidden flex-col items-center gap-0.5 rounded-lg border border-gray-300 bg-white p-1 shadow-[0_4px_12px_rgba(0,0,0,0.1)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-[''] group-hover:flex"
      >
        <button
          v-for="opt in edgeOptions"
          :key="opt.value"
          class="flex h-14 w-14 cursor-pointer items-center justify-center rounded-md text-sm text-gray-500 hover:bg-gray-100"
          :class="{ 'bg-[#e5edff] text-blue-700': edge === opt.value }"
          :title="opt.title"
          @click="pickEdge(opt.value)"
        >
          <component :is="edgeIcons[opt.value]" class="h-9 w-9 shrink-0" />
        </button>
      </div>
    </div>

    <!-- 缩放：数字触发器 + 滑块面板 -->
    <div class="group relative">
      <button
        class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100"
        title="缩放"
      >
        <span class="text-[11px] tabular-nums">{{ zoom }}</span>
      </button>
      <div
        class="absolute top-[calc(100%+10px)] right-0 z-20 hidden min-w-45 flex-col items-center rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 shadow-[0_4px_12px_rgba(0,0,0,0.1)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-[''] group-hover:flex"
      >
        <input
          class="w-35 cursor-pointer"
          type="range"
          min="20"
          max="800"
          :value="zoom"
          step="5"
          @input="onZoomInput"
        />
      </div>
    </div>
  </div>
</template>
