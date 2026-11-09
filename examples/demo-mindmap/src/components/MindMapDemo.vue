<script setup lang="ts">
// 思维导图 Demo：canvas + 胶囊工具条（撤销/重做、布局方向、连线形状、缩放）+
// 文档切换器（IndexedDB 持久化：新建/打开/自动保存/删除）
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { App, type EdgeShape } from "@silker/core";
import { officialPlugins } from "@silker/preset";
import { MindMap, defaultAIEditPrompt, type AIEditGenerate, type AIEditStep, type MindMapNode, type Style } from "@silker/mindmap";
import { listDocs, getDoc, putDoc, deleteDoc, type MindMapDoc } from "../idb";
import Undo from "../icons/Undo.vue";
import Redo from "../icons/Redo.vue";
import LayoutRight from "../icons/LayoutRight.vue";
import LayoutLeft from "../icons/LayoutLeft.vue";
import LayoutBoth from "../icons/LayoutBoth.vue";
import LayoutDown from "../icons/LayoutDown.vue";
import EdgeBezier from "../icons/EdgeBezier.vue";
import EdgePath from "../icons/EdgePath.vue";
import EdgeRPath from "../icons/EdgeRPath.vue";
import Export from "../icons/Export.vue";
import File from "../icons/File.vue";
import Plus from "../icons/Plus.vue";
import Trash from "../icons/Trash.vue";
import Chevron from "../icons/Chevron.vue";
import Sparkles from "../icons/Sparkles.vue";
import Settings from "../icons/Settings.vue";

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
// 复制 JSON 成功后的短暂反馈
const copied = ref(false);

// ---- AI 编辑（@silker/mindmap AIEditingPlugin + OpenAI 兼容接口，对话式侧边栏）----
// 聊天消息流：历史对话保留在内存，不随单次对话丢失
interface AIChatMessage {
  id: number;
  // user = 用户指令；assistant = AI 回复（回答/反馈/思考）；error = 失败信息
  role: "user" | "assistant" | "error";
  text: string;
  steps?: AIEditStep[]; // 本次执行的反馈链
  reasoning?: string; // 思考过程（完成后保留可折叠回看）
}
let aiMsgSeq = 0;
const aiMessages = ref<AIChatMessage[]>([]);
// 进行中的回复：流式思考实时更新，完成后并入 aiMessages
const aiPending = ref<{ reasoning: string } | null>(null);
const aiSidebarOpen = ref(true);
const aiPrompt = ref("");
const aiBusy = ref(false);
const aiSettingsOpen = ref(false);
const chatBox = ref<HTMLDivElement | null>(null);

// AI 服务配置（OpenAI 兼容接口，DeepSeek/通义/Kimi/OpenAI 等均适用），
// 运行时在面板设置弹层里填写，持久化到 localStorage（不入代码仓库）
interface AIConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}
const AI_CONFIG_KEY = "mindmap-ai-config";
const aiConfig = ref<AIConfig>(loadAIConfig());
// 三项齐全才可调用
const aiReady = computed(
  () => !!(aiConfig.value.baseURL && aiConfig.value.apiKey && aiConfig.value.model),
);

// 新消息或流式思考更新时，消息流自动跟随到底部
watch([aiMessages, aiPending], async () => {
  await nextTick();
  const box = chatBox.value;
  if (box) box.scrollTop = box.scrollHeight;
}, { deep: true });

function loadAIConfig(): AIConfig {
  try {
    return { baseURL: "", apiKey: "", model: "", ...JSON.parse(localStorage.getItem(AI_CONFIG_KEY) ?? "{}") };
  } catch {
    return { baseURL: "", apiKey: "", model: "" };
  }
}

function saveAIConfig() {
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(aiConfig.value));
  aiSettingsOpen.value = false;
}

// 真实 AI 适配器：请求 OpenAI 兼容 chat/completions（流式），提示词用包内缺省
// 模板（含操作 schema 与当前导图数据），返回文本交给 AIEditingController 解析
// （自动容错 markdown 代码块包裹，target 缺省锚点/支持节点文本定位）。
// 思考过程：delta 上的 reasoning_content / reasoning 字段（DeepSeek-R1、通义、
// Kimi 等推理模型）逐段收集到进行中消息实时展示；非流式响应退回一次性读取。
// 注意：浏览器直连要求服务端允许 CORS，否则需经本地代理转发
const realGenerate: AIEditGenerate = async (req) => {
  const { baseURL, apiKey, model } = aiConfig.value;
  if (!baseURL || !apiKey || !model)
    throw new Error("请先点击右上角齿轮配置 AI 服务");
  if (aiPending.value) aiPending.value.reasoning = "";
  const res = await fetch(baseURL.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: defaultAIEditPrompt(req) }],
      temperature: 0.3,
      stream: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AI 服务请求失败（HTTP ${res.status}）${text ? `：${text.slice(0, 160)}` : ""}`);
  }
  // 服务端不支持流式：一次性读取，思考过程取完整 message 字段
  if (!res.body) {
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (aiPending.value)
      aiPending.value.reasoning = msg?.reasoning_content ?? msg?.reasoning ?? "";
    if (!msg?.content) throw new Error("AI 服务返回内容为空");
    return msg.content;
  }
  // SSE 流式解析：逐 delta 分离思考（reasoning）与答案（content）
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta;
        if (!delta) continue;
        const think = delta.reasoning_content ?? delta.reasoning;
        if (typeof think === "string" && think && aiPending.value)
          aiPending.value.reasoning += think;
        if (typeof delta.content === "string") content += delta.content;
      } catch {
        // 忽略无法解析的行（心跳/注释等）
      }
    }
  }
  if (!content) throw new Error("AI 服务返回内容为空");
  return content;
};

// 发送消息：编辑类指令产出一个原子变更（可整体撤销），提问类返回回答；
// 全部对话（指令/回答/反馈/思考）保留在消息流中
async function sendAi() {
  if (!mindmap || aiBusy.value) return;
  const prompt = aiPrompt.value.trim();
  if (!prompt) return;
  // 未配置 AI 服务：直接展开设置面板
  if (!aiReady.value) {
    aiSidebarOpen.value = true;
    aiSettingsOpen.value = true;
    return;
  }
  aiMessages.value.push({ id: ++aiMsgSeq, role: "user", text: prompt });
  aiPrompt.value = "";
  const replyId = ++aiMsgSeq;
  aiBusy.value = true;
  aiPending.value = { reasoning: "" };
  try {
    const r = await mindmap.ai.run(prompt);
    aiMessages.value.push({
      id: replyId,
      role: "assistant",
      text: r.answer ?? (r.applied ? "" : "（未产生任何操作）"),
      steps: r.steps.length ? r.steps : undefined,
      reasoning: aiPending.value?.reasoning || undefined,
    });
  } catch (e) {
    aiMessages.value.push({
      id: replyId,
      role: "error",
      text: e instanceof Error ? e.message : String(e),
    });
  } finally {
    aiBusy.value = false;
    aiPending.value = null;
  }
}

// ---- 文档管理状态（IndexedDB 持久化 + 自动保存）----
// 已保存文档列表（按更新时间倒序，仅用于左上角文档菜单）
const docs = ref<MindMapDoc[]>([]);
// 当前打开的文档 id 与名称；空 id 表示尚未打开（首帧）
const currentId = ref("");
const docName = ref("");
// 自动保存防抖定时器与当前文档建档时间
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let docCreatedAt = 0;

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

// 非 响应式实例：App/MindMap 内部状态复杂，不做深度代理，UI 状态经上面的 ref 单向同步。
// mindmap 可为 null（异步首挂载前 / 文档切换重建间隙），UI 回调先做守卫
let app!: App;
let mindmap: MindMap | null = null;

function syncToolbar() {
  canUndo.value = mindmap?.canUndo ?? false;
  canRedo.value = mindmap?.canRedo ?? false;
}

function pickLayout(value: LayoutDirection) {
  if (!mindmap) return;
  layout.value = value;
  // 同一实例原地设置：数据、选中态、撤销栈均保留
  void mindmap.setLayout(value);
}

function pickEdge(value: EdgeShape) {
  if (!mindmap) return;
  edge.value = value;
  // 同一实例原地重建连线，数据、选中态、撤销栈均保留
  mindmap.setEdgeStyle(value);
}

async function undo() {
  if (!mindmap) return;
  await mindmap.undo();
  syncToolbar();
}

async function redo() {
  if (!mindmap) return;
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

// 滑块轨道填充：滑块左侧为深色已填充段，右侧为浅色剩余段
const zoomTrackStyle = computed(() => {
  const pct = ((zoom.value - 20) / (800 - 20)) * 100;
  return {
    background: `linear-gradient(to right, #111827 ${pct}%, #e5e7eb ${pct}%)`,
  };
});

// 触发浏览器下载：URL.revokeObjectURL 在 click 同步消费后即可释放
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function copyJson() {
  if (!mindmap) return;
  navigator.clipboard
    .writeText(JSON.stringify(mindmap.toJSON(), null, 2))
    .then(() => {
      copied.value = true;
      setTimeout(() => (copied.value = false), 1500);
    });
}

function exportJson() {
  if (!mindmap) return;
  download(
    new Blob([JSON.stringify(mindmap.toJSON(), null, 2)], {
      type: "application/json",
    }),
    "mindmap.json",
  );
}

async function exportImage() {
  if (!mindmap) return;
  // 白底 PNG：padding/scale 走能力默认值（24 世界像素 / 2x）
  const blob = await mindmap.toImage({ background: "#ffffff" });
  download(blob, "mindmap.png");
}

async function exportImageHd() {
  if (!mindmap) return;
  // 高清版：默认已是 2x，"2 倍高清" 再翻倍到 4x
  const blob = await mindmap.toImage({ background: "#ffffff", scale: 4 });
  download(blob, "mindmap-hd.png");
}

// ---- 文档管理（IndexedDB 持久化 + 自动保存）----

// 拉取文档列表（按更新时间倒序）
function refreshDocs() {
  return listDocs().then((all) => {
    docs.value = all.sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

// 把当前场景数据落盘到当前文档（布局方向与连线样式随档保存）
function saveCurrent() {
  if (!mindmap || !currentId.value) return;
  void putDoc({
    id: currentId.value,
    name: docName.value,
    data: mindmap.toJSON(),
    direction: layout.value,
    edgeStyle: edge.value,
    createdAt: docCreatedAt,
    updatedAt: Date.now(),
  }).then(refreshDocs);
}

// 数据变化后防抖自动保存：连续编辑合并为一次写库
function scheduleSave() {
  if (!currentId.value) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveCurrent();
  }, 600);
}

// 切换/新建/关闭前立刻落盘：取消待保存的定时器，此时 currentId 尚未变更，归属正确
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveCurrent();
}

// 挂载场景：宿主 App 与官方插件复用（MindMap.destroy 对称拆卸自有插件与
// 场景节点，App 不受影响），销毁旧门面后以新数据重建，实现打开/新建导图
function mountScene(nodeData: MindMapNode, direction: LayoutDirection, shape: EdgeShape) {
  mindmap?.destroy();
  mindmap = new MindMap({
    app,
    data: nodeData,
    direction,
    edgeStyle: shape,
    levelStyles,
    // AI 编辑生成适配器（OpenAI 兼容接口，配置见面板设置弹层）
    ai: realGenerate,
    // 数据变化（新增/删除/移动/文本编辑/折叠/布局/连线/AI 编辑）时同步工具条并自动保存
    onChange: () => {
      syncToolbar();
      scheduleSave();
    },
  });
  syncToolbar();
  // 临时调试：暴露实例供浏览器自动化测试定位节点（验证后移除）
  (window as any).__mindmap = mindmap;
}

// 新建导图：先落盘当前文档，再以新 id 建档并重建场景；initial 为首档示例数据
function createNew(initial?: MindMapNode) {
  flushSave();
  const now = Date.now();
  const doc: MindMapDoc = {
    id: crypto.randomUUID(),
    name: "未命名导图",
    data: initial ?? { text: "中心主题", children: [] },
    direction: layout.value,
    edgeStyle: edge.value,
    createdAt: now,
    updatedAt: now,
  };
  currentId.value = doc.id;
  docName.value = doc.name;
  docCreatedAt = now;
  void putDoc(doc).then(refreshDocs);
  mountScene(doc.data, doc.direction, doc.edgeStyle);
}

// 打开指定文档：先落盘当前文档，再按档内偏好（方向/连线）还原场景
async function openDoc(id: string) {
  if (id === currentId.value) return;
  flushSave();
  const doc = await getDoc(id);
  if (!doc) return;
  currentId.value = doc.id;
  docName.value = doc.name;
  docCreatedAt = doc.createdAt;
  layout.value = doc.direction;
  edge.value = doc.edgeStyle;
  mountScene(doc.data, doc.direction, doc.edgeStyle);
}

// 删除文档：删除当前文档时不落盘（避免删后又被定时器写回），随后自动新建空白档
async function removeDoc(id: string) {
  if (id === currentId.value) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    currentId.value = "";
    await deleteDoc(id);
    refreshDocs();
    createNew();
  } else {
    await deleteDoc(id);
    refreshDocs();
  }
}

// 相对时间显示：列表项的更新时间
function formatTime(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

onMounted(async () => {
  const canvas = canvasRef.value!;

  // 显式装配：自建 App 并安装官方插件预设（集合与顺序的单一事实来源在 @silker/preset），
  // MindMap 按能力键复用这些能力，只补齐自有的布局插件
  app = new App(canvas);
  for (const p of officialPlugins()) app.use(p);

  // 滚轮等外部视口变化 → 同步滑块与百分比显示
  app.camera.onViewportChange(() => {
    zoom.value = Math.round(app.camera.scale * 100);
  });

  // 关闭页面前落盘未保存的变更
  window.addEventListener("beforeunload", flushSave);

  // 打开最近编辑的文档；本地无历史文档时以示例数据新建首档
  await refreshDocs();
  const latest = docs.value[0];
  if (latest) {
    currentId.value = latest.id;
    docName.value = latest.name;
    docCreatedAt = latest.createdAt;
    layout.value = latest.direction;
    edge.value = latest.edgeStyle;
    mountScene(latest.data, latest.direction, latest.edgeStyle);
  } else {
    // 首次使用：以示例数据创建首个文档
    createNew(data);
  }
});

onUnmounted(() => {
  window.removeEventListener("beforeunload", flushSave);
  flushSave();
  mindmap?.destroy();
  mindmap = null;
});
</script>

<template>
  <canvas ref="canvasRef" class="block h-screen w-screen bg-white"></canvas>

  <!-- 文档切换器：新建导图 / 打开历史导图（IndexedDB 自动保存） -->
  <div class="fixed top-4 left-4 z-10">
    <div class="group relative">
      <button
        class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-white px-3 shadow-[0_2px_8px_rgba(0,0,0,0.1)]"
        title="导图列表"
      >
        <File class="h-4 w-4 shrink-0 text-gray-500" />
        <span class="max-w-40 truncate text-xs text-gray-800">
          {{ docName || "加载中…" }}
        </span>
        <Chevron class="h-3 w-3 shrink-0 text-gray-400" />
      </button>
      <div
        class="absolute top-[calc(100%+10px)] left-0 z-20 hidden w-56 flex-col rounded-lg bg-white p-1 shadow-[0_4px_16px_rgba(0,0,0,0.12)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-[''] group-hover:flex"
      >
        <button
          class="flex w-full cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100"
          @click="createNew()"
        >
          <Plus class="h-3.5 w-3.5 shrink-0" />
          新建导图
        </button>
        <div class="mx-2 my-1 border-t border-gray-100"></div>
        <div class="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          <div
            v-for="d in docs"
            :key="d.id"
            class="group/row flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 hover:bg-gray-100"
            :class="{ 'bg-[#e5edff] text-blue-700': d.id === currentId }"
            @click="openDoc(d.id)"
          >
            <File class="h-3.5 w-3.5 shrink-0 text-gray-400" />
            <div class="min-w-0 flex-1 text-left">
              <div class="truncate text-xs" :class="{ 'text-blue-700': d.id === currentId }">
                {{ d.name }}
              </div>
              <div class="text-[10px] text-gray-400">
                {{ formatTime(d.updatedAt) }}
              </div>
            </div>
            <button
              class="hidden h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-gray-400 hover:text-red-500 group-hover/row:flex"
              title="删除"
              @click.stop="removeDoc(d.id)"
            >
              <Trash class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 单一胶囊工具条：撤销/重做可点击，其余项悬浮展开选项面板 -->
  <div
    class="fixed top-4 right-4 z-10 flex items-center gap-0.5 rounded-lg bg-white p-1 shadow-[0_2px_8px_rgba(0,0,0,0.1)]"
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
        class="absolute top-[calc(100%+10px)] right-0 z-20 hidden flex-col items-center gap-0.5 rounded-lg bg-white p-1 shadow-[0_4px_16px_rgba(0,0,0,0.12)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-[''] group-hover:flex"
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
        class="absolute top-[calc(100%+10px)] right-0 z-20 hidden flex-col items-center gap-0.5 rounded-lg bg-white p-1 shadow-[0_4px_16px_rgba(0,0,0,0.12)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-[''] group-hover:flex"
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

    <!-- 导出：复制 JSON / 下载 JSON / 导出图片 -->
    <div class="group relative">
      <button
        class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100"
        title="导出"
      >
        <Export class="block h-4 w-4 shrink-0" />
      </button>
      <div
        class="absolute top-[calc(100%+10px)] right-0 z-20 hidden min-w-28 flex-col rounded-lg bg-white p-1 shadow-[0_4px_16px_rgba(0,0,0,0.12)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-[''] group-hover:flex"
      >
        <button
          class="w-full cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100"
          @click="copyJson"
        >
          {{ copied ? "已复制" : "复制 JSON" }}
        </button>
        <button
          class="w-full cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100"
          @click="exportJson"
        >
          导出 JSON
        </button>
        <button
          class="w-full cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100"
          @click="exportImage"
        >
          导出图片
        </button>
        <button
          class="w-full cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100"
          @click="exportImageHd"
        >
          导出图片（2倍高清）
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
        class="absolute top-[calc(100%+10px)] right-0 z-20 hidden min-w-45 flex-col items-center rounded-lg bg-white px-3.5 py-2.5 shadow-[0_4px_16px_rgba(0,0,0,0.12)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-[''] group-hover:flex"
      >
        <input
          class="h-1 w-35 cursor-pointer appearance-none rounded-full outline-none [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:cursor-grab [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-gray-900 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gray-900 [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
          :style="zoomTrackStyle"
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

  <!-- AI 助手侧边栏：对话式交互，历史消息保留（用户指令 / AI 回答 / 执行反馈 / 思考过程） -->
  <div
    v-if="aiSidebarOpen"
    class="fixed top-0 right-0 z-20 flex h-full w-90 max-w-[92vw] flex-col bg-white shadow-[-8px_0_24px_rgba(0,0,0,0.08)]"
  >
    <!-- 头部 -->
    <div class="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
      <Sparkles class="h-4 w-4 text-violet-500" />
      <span class="flex-1 text-sm font-medium text-gray-800">AI 助手</span>
      <button
        class="cursor-pointer text-xs text-gray-400 hover:text-gray-600"
        :disabled="aiBusy || !aiMessages.length"
        @click="aiMessages = []"
      >
        清空
      </button>
      <button
        class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg hover:bg-gray-100"
        :class="aiReady ? 'text-violet-500' : 'text-gray-400'"
        title="AI 服务配置"
        @click="aiSettingsOpen = !aiSettingsOpen"
      >
        <Settings class="h-4 w-4" />
      </button>
      <button
        class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100"
        title="收起"
        @click="aiSidebarOpen = false"
      >
        <Chevron class="h-4 w-4" />
      </button>
    </div>

    <!-- 服务配置（OpenAI 兼容接口，localStorage 持久化） -->
    <div
      v-if="aiSettingsOpen"
      class="flex flex-col gap-2 border-b border-gray-100 bg-gray-50 p-3"
    >
      <input
        v-model="aiConfig.baseURL"
        class="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-xs outline-none focus:border-violet-400"
        placeholder="接口地址（含 /v1），如 https://api.deepseek.com/v1"
      />
      <input
        v-model="aiConfig.apiKey"
        class="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-xs outline-none focus:border-violet-400"
        type="password"
        placeholder="API Key"
      />
      <input
        v-model="aiConfig.model"
        class="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-xs outline-none focus:border-violet-400"
        placeholder="模型名，如 deepseek-chat"
      />
      <div class="flex items-center justify-between">
        <span class="text-[10px] text-gray-400">保存在浏览器本地；服务端需允许跨域或走本地代理</span>
        <button
          class="h-7 shrink-0 cursor-pointer rounded-lg bg-gray-900 px-3 text-xs text-white hover:bg-gray-700"
          @click="saveAIConfig"
        >
          保存
        </button>
      </div>
    </div>

    <!-- 消息流 -->
    <div ref="chatBox" class="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div v-if="!aiMessages.length && !aiPending" class="mt-10 text-center text-xs leading-5 text-gray-400">
        输入编辑指令或提问，如：<br />围绕前端展开 / 把测试改为：质量保障 / 这个导图讲了什么
      </div>

      <div v-for="m in aiMessages" :key="m.id">
        <!-- 用户指令：右侧气泡 -->
        <div v-if="m.role === 'user'" class="flex justify-end">
          <div class="max-w-[85%] rounded-xl rounded-br-sm bg-violet-500 px-3 py-2 text-xs leading-5 text-white">
            {{ m.text }}
          </div>
        </div>
        <!-- 错误 -->
        <div v-else-if="m.role === 'error'" class="text-xs leading-5 text-red-500">
          {{ m.text }}
        </div>
        <!-- AI 回复：思考过程（可折叠）+ 回答 + 执行反馈链 -->
        <div v-else class="flex flex-col gap-2">
          <details v-if="m.reasoning" class="rounded-lg bg-gray-50 px-2.5 py-1.5">
            <summary class="cursor-pointer text-xs text-gray-400 select-none">思考过程</summary>
            <div class="mt-1 text-[11px] leading-5 whitespace-pre-wrap text-gray-400">{{
              m.reasoning
            }}</div>
          </details>
          <div
            v-if="m.text"
            class="text-xs leading-5 whitespace-pre-wrap text-gray-600"
            >{{ m.text }}</div
          >
          <div v-if="m.steps?.length" class="flex flex-col gap-1">
            <div
              v-for="(s, i) in m.steps"
              :key="i"
              class="flex items-start gap-1.5 text-xs leading-5"
            >
              <span :class="s.status === 'applied' ? 'text-emerald-500' : 'text-gray-300'">{{
                s.status === "applied" ? "✓" : "–"
              }}</span>
              <span :class="s.status === 'applied' ? 'text-gray-600' : 'text-gray-400'">{{
                s.label
              }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 进行中：流式思考实时展示 -->
      <div v-if="aiPending" class="flex flex-col gap-2">
        <details
          v-if="aiPending.reasoning"
          open
          class="rounded-lg bg-gray-50 px-2.5 py-1.5"
        >
          <summary class="cursor-pointer text-xs text-gray-400 select-none">思考中…</summary>
          <div class="mt-1 text-[11px] leading-5 whitespace-pre-wrap text-gray-400">{{
            aiPending.reasoning
          }}</div>
        </details>
        <div v-else class="flex items-center gap-1.5 text-xs text-gray-400">
          <Sparkles class="h-3.5 w-3.5 animate-pulse text-violet-400" />
          思考中…
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="flex items-center gap-2 border-t border-gray-100 p-2.5">
      <input
        v-model="aiPrompt"
        class="h-9 min-w-0 flex-1 rounded-lg bg-gray-50 px-3 text-sm text-gray-800 outline-none placeholder:text-gray-400 disabled:opacity-60"
        :disabled="aiBusy"
        placeholder="输入指令或提问…"
        @keydown.enter="sendAi"
      />
      <button
        class="h-9 shrink-0 cursor-pointer rounded-lg bg-violet-500 px-3.5 text-xs text-white hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="aiBusy || !aiPrompt.trim()"
        @click="sendAi"
      >
        {{ aiBusy ? "思考中…" : "发送" }}
      </button>
    </div>
  </div>

  <!-- 侧边栏收起时的悬浮入口 -->
  <button
    v-if="!aiSidebarOpen"
    class="fixed top-4 right-4 z-20 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white shadow-[0_4px_16px_rgba(0,0,0,0.12)] hover:bg-gray-50"
    title="AI 助手"
    @click="aiSidebarOpen = true"
  >
    <Sparkles class="h-4 w-4 text-violet-500" />
  </button>
</template>
