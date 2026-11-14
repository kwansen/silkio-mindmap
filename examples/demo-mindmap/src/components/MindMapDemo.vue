<script setup lang="ts">
// 思维导图 Demo：canvas + 胶囊工具条（撤销/重做、适应视图/居中、布局方向、连线形状、缩放）+
// 文档切换器（IndexedDB 持久化：新建/打开/自动保存/删除）
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import { App, type EdgeShape } from "@silkor/core";
import { officialPlugins } from "@silkor/preset";
import {
  MindMap,
  defaultAIEditPrompt,
  type AIEditGenerate,
  type AIEditStep,
  type AIEditTurn,
  type MindMapNode,
  type Style,
} from "silkio-mindmap";
import { Markdown } from "@comark/vue";
import { listDocs, getDoc, putDoc, deleteDoc, type MindMapDoc } from "../idb";
import IconSprites from "./IconSprites.vue";
import Icon from "./Icon.vue";

type LayoutDirection = "left" | "right" | "down" | "both";

// 级数样式配置：index 0 为根节点（一级），依次向深层级递增，超出配置长度套用最后一项
const levelStyles: Style[] = [
  // 一级样式：根节点
  {
    color: "#ffffffff",
    backgroundColor: "#A4B3C2",
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
    backgroundColor: "#DCE2E8",
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
    backgroundColor: "#F9FAFB",
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
  text: "三角形",
  children: [
    { text: "锐角三角形", children: [] },
    { text: "直角三角形", children: [] },
    { text: "钝角三角形", children: [] },
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

// ---- AI 编辑（silkio-mindmap AIEditingPlugin + OpenAI 兼容接口，对话式侧边栏）----
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
// 进行中的回复：流式思考与回答文本实时更新，完成后并入 aiMessages
// content 为 SSE 累积的回答原文，经 comark 流式渲染；编辑类指令输出的是操作
// JSON（isOpsStream 命中），不实时渲染，等控制器解析后以反馈链展示
const aiPending = ref<{ reasoning: string; content: string } | null>(null);
const aiSidebarOpen = ref(true);
const aiPrompt = ref("");
const aiBusy = ref(false);
// 当前 AI 请求的中止控制器：停止按钮 abort 它以取消进行中的生成（fetch 与流式读取一并中断）
let aiAbort: AbortController | null = null;
const aiSettingsOpen = ref(false);
const chatBox = ref<HTMLDivElement | null>(null);

// AI 服务配置（运行时在面板设置弹层里填写，持久化到 localStorage，不入代码仓库）。
// format：openai = OpenAI Chat Completions 兼容接口（DeepSeek/通义/Kimi/OpenAI 等
// 均适用）；anthropic = Anthropic Messages 原生格式
interface AIConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  format: "openai" | "anthropic";
}
const AI_CONFIG_KEY = "mindmap-ai-config";
const aiConfig = ref<AIConfig>(loadAIConfig());
// 三项齐全才可调用
const aiReady = computed(
  () =>
    !!(aiConfig.value.baseURL && aiConfig.value.apiKey && aiConfig.value.model),
);

// 新消息或流式思考更新时，消息流自动跟随到底部
watch(
  [aiMessages, aiPending],
  async () => {
    await nextTick();
    const box = chatBox.value;
    if (box) box.scrollTop = box.scrollHeight;
  },
  { deep: true },
);

function loadAIConfig(): AIConfig {
  try {
    return {
      baseURL: "",
      apiKey: "",
      model: "",
      format: "openai",
      ...JSON.parse(localStorage.getItem(AI_CONFIG_KEY) ?? "{}"),
    };
  } catch {
    return { baseURL: "", apiKey: "", model: "", format: "openai" };
  }
}

function saveAIConfig() {
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(aiConfig.value));
  aiSettingsOpen.value = false;
}

// 真实 AI 适配器：按配置的 API 格式分流。提示词用包内缺省模板（含操作 schema
// 与当前导图数据），返回文本交给 AIEditingController 解析（自动容错 markdown
// 代码块包裹，target 缺省锚点/支持节点文本定位）。
// 注意：浏览器直连要求服务端允许 CORS，否则需经本地代理转发
const realGenerate: AIEditGenerate = async (req) => {
  const { baseURL, apiKey, model, format } = aiConfig.value;
  if (!baseURL || !apiKey || !model)
    throw new Error("请先点击右上角齿轮配置 AI 服务");
  const prompt = defaultAIEditPrompt(req);
  return format === "anthropic"
    ? anthropicGenerate({ baseURL, apiKey, model }, prompt)
    : openaiGenerate({ baseURL, apiKey, model }, prompt);
};

// OpenAI Chat Completions 兼容格式（默认）：请求 baseURL + /chat/completions（流式）。
// 思考过程：delta 上的 reasoning_content / reasoning 字段（DeepSeek-R1、通义、
// Kimi 等推理模型）逐段收集到进行中消息实时展示；非流式响应退回一次性读取
async function openaiGenerate(
  cfg: { baseURL: string; apiKey: string; model: string },
  prompt: string,
): Promise<string> {
  if (aiPending.value) {
    aiPending.value.reasoning = "";
    aiPending.value.content = "";
  }
  const ac = new AbortController();
  aiAbort = ac;
  const res = await fetch(cfg.baseURL.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    signal: ac.signal,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      stream: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `AI 服务请求失败（HTTP ${res.status}）${text ? `：${text.slice(0, 160)}` : ""}`,
    );
  }
  // 服务端不支持流式：一次性读取，思考过程取完整 message 字段
  if (!res.body) {
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (aiPending.value)
      aiPending.value.reasoning =
        msg?.reasoning_content ?? msg?.reasoning ?? "";
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
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          // 流式回答实时并入进行中消息，由 comark 流式渲染
          if (aiPending.value) aiPending.value.content = content;
        }
      } catch {
        // 忽略无法解析的行（心跳/注释等）
      }
    }
  }
  if (!content) throw new Error("AI 服务返回内容为空");
  return content;
}

// Anthropic Messages 原生格式：baseURL 需含 /v1（如 https://api.anthropic.com/v1），
// 端点为 baseURL + /messages；鉴权用 x-api-key + anthropic-version 头。
// 浏览器直连官方 API 必须显式声明 anthropic-dangerous-direct-browser-access 才允许
// CORS。扩展思考（thinking）要求固定 temperature=1 且按模型逐个开启，此处不默认
// 发送——Anthropic 模式下思考过程为空，仅答案文本流式展示
async function anthropicGenerate(
  cfg: { baseURL: string; apiKey: string; model: string },
  prompt: string,
): Promise<string> {
  if (aiPending.value) {
    aiPending.value.reasoning = "";
    aiPending.value.content = "";
  }
  const ac = new AbortController();
  aiAbort = ac;
  const res = await fetch(cfg.baseURL.replace(/\/+$/, "") + "/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    signal: ac.signal,
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 8192,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `AI 服务请求失败（HTTP ${res.status}）${text ? `：${text.slice(0, 160)}` : ""}`,
    );
  }
  // 非流式兜底：content 数组按块类型分离思考与答案
  if (!res.body) {
    const json = await res.json();
    const blocks: Array<{ type: string; text?: string; thinking?: string }> =
      json?.content ?? [];
    if (aiPending.value) {
      aiPending.value.reasoning = blocks
        .filter((b) => b.type === "thinking")
        .map((b) => b.thinking ?? "")
        .join("");
    }
    const content = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (!content) throw new Error("AI 服务返回内容为空");
    if (aiPending.value) aiPending.value.content = content;
    return content;
  }
  // SSE 流式解析：content_block_delta 事件按 delta.type 分离
  // 思考（thinking_delta）与答案（text_delta）
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
        const event = JSON.parse(payload);
        if (event?.type !== "content_block_delta" || !event.delta) continue;
        const delta = event.delta;
        if (delta.type === "thinking_delta" && delta.thinking && aiPending.value) {
          aiPending.value.reasoning += delta.thinking;
        } else if (delta.type === "text_delta" && delta.text) {
          content += delta.text;
          if (aiPending.value) aiPending.value.content = content;
        }
      } catch {
        // 忽略无法解析的行（ping/心跳等）
      }
    }
  }
  if (!content) throw new Error("AI 服务返回内容为空");
  return content;
}

// 流式内容是否为操作 JSON（编辑类指令的输出）：JSON 输出等控制器解析完成后以
// 反馈链展示，不实时渲染原始 JSON；纯文本回答才走 comark 流式渲染
function isOpsStream(text: string): boolean {
  const s = text.trimStart();
  return s.startsWith("{") || s.startsWith("[") || s.startsWith("```");
}

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
  // 对话历史（不含本次指令）：从消息流收集用户/助手轮次，随请求传给生成适配器
  // ——助手轮无回答文本时以反馈链步骤摘要代之，让模型知道上一轮实际做了什么
  const history: AIEditTurn[] = aiMessages.value
    .filter((m) => m.role !== "error")
    .map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text:
        m.text ||
        (m.steps && m.steps.length
          ? m.steps.map((s) => s.label).join("；")
          : ""),
    }))
    .filter((t) => t.text);
  aiMessages.value.push({ id: ++aiMsgSeq, role: "user", text: prompt });
  aiPrompt.value = "";
  const replyId = ++aiMsgSeq;
  const sentDocId = currentId.value;
  aiBusy.value = true;
  aiPending.value = { reasoning: "", content: "" };
  try {
    const r = await mindmap.ai.run(prompt, { history });
    // 等待期间切换/新建了导图：旧文档的回复不落入新对话流
    if (currentId.value !== sentDocId) return;
    aiMessages.value.push({
      id: replyId,
      role: "assistant",
      text: r.answer ?? (r.applied ? "" : "（未产生任何操作）"),
      steps: r.steps.length ? r.steps : undefined,
      reasoning: aiPending.value?.reasoning || undefined,
    });
  } catch (e) {
    if (currentId.value !== sentDocId) return;
    // 用户主动停止：不算错误，保留已流式产生的部分回答（无内容则给提示）
    if (e instanceof DOMException && e.name === "AbortError") {
      const partial = aiPending.value?.content ?? "";
      aiMessages.value.push({
        id: replyId,
        role: "assistant",
        text: partial && !isOpsStream(partial) ? partial : "（已停止生成）",
        reasoning: aiPending.value?.reasoning || undefined,
      });
      return;
    }
    aiMessages.value.push({
      id: replyId,
      role: "error",
      text: e instanceof Error ? e.message : String(e),
    });
  } finally {
    aiBusy.value = false;
    aiPending.value = null;
    aiAbort = null;
  }
}

// 停止正在进行的 AI 生成：中断请求与流式读取，回到可继续输入状态
function stopAi() {
  aiAbort?.abort();
}

// 清空 AI 对话流：新建/切换导图时调用，避免旧文档的指令与回答污染新文档的对话
function clearAiChat() {
  aiMessages.value = [];
  aiPending.value = null;
}

// ---- 文档管理状态（IndexedDB 持久化 + 自动保存）----
// 已保存文档列表（仅用于左上角文档 dialog）
const docs = ref<MindMapDoc[]>([]);
// 文档 dialog 与排序状态：按创建/更新时间 + 升降序
const docsOpen = ref(false);
const sortKey = ref<"createdAt" | "updatedAt">("updatedAt");
const sortAsc = ref(false);
const sortedDocs = computed(() => {
  const arr = [...docs.value];
  arr.sort(
    (a, b) => (sortAsc.value ? 1 : -1) * (a[sortKey.value] - b[sortKey.value]),
  );
  return arr;
});
// 当前打开的文档 id 与名称；空 id 表示尚未打开（首帧）
const currentId = ref("");
const docName = ref("");
// 自动保存防抖定时器与当前文档建档时间
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let docCreatedAt = 0;
// 上次落盘内容快照（数据 + 方向 + 连线）：保存前对比，内容未变不写库。
// 打开/新建时建立基线，挂载还原触发的 onChange 因对比相等而不会误更新
let lastSaved = "";

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

// value → 图标 symbol 映射：触发器与下拉菜单复用同一套图标
const layoutIcons: Record<LayoutDirection, string> = {
  right: "i-layout-right",
  left: "i-layout-left",
  both: "i-layout-both",
  down: "i-layout-down",
};

const edgeIcons: Record<EdgeShape, string> = {
  bezier: "i-edge-bezier",
  path: "i-edge-path",
  rPath: "i-edge-rpath",
};

// 非 响应式实例：App/MindMap 内部状态复杂，不做深度代理，UI 状态经上面的 ref 单向同步。
// mindmap 可为 null（异步首挂载前 / 文档切换重建间隙），UI 回调先做守卫
let app!: App;
let mindmap: MindMap | null = null;

function syncToolbar() {
  canUndo.value = mindmap?.canUndo ?? false;
  canRedo.value = mindmap?.canRedo ?? false;
  // 文档名跟随根节点文本：任何变化（编辑/撤销/重做/AI 编辑）都会经此同步
  if (mindmap) docName.value = mindmap.toJSON().text;
}

// ---- 工具条悬浮面板：悬浮 200ms 延迟展开（hover intent），移出立即收起 ----
// 纯 CSS group-hover 过于灵敏，鼠标划过工具条即弹面板易误触；改为定时器延迟
type ToolbarMenu = "layout" | "edge" | "export" | "zoom";
const openMenu = ref<ToolbarMenu | null>(null);
let menuTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleMenu(menu: ToolbarMenu) {
  if (menuTimer) clearTimeout(menuTimer);
  menuTimer = setTimeout(() => (openMenu.value = menu), 200);
}
function closeMenu() {
  if (menuTimer) {
    clearTimeout(menuTimer);
    menuTimer = null;
  }
  openMenu.value = null;
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

// 适应视图：按整棵可见子树包围盒拟合视口；居中：保持缩放只平移。
// 视口变化经 app.camera.onViewportChange 回流，缩放滑块自动同步
function fit() {
  mindmap?.fit();
}

function center() {
  mindmap?.center();
}

// 以画布中心为锚点设置缩放（与缩放滑块同一世界锚点换算）
function setZoom(scale: number) {
  const vp = app.camera.viewport;
  const rect = canvasRef.value!.getBoundingClientRect();
  // 画布中心的世界坐标在缩放前后保持不动
  const wx = (rect.width / 2 - vp.x) / vp.scale;
  const wy = (rect.height / 2 - vp.y) / vp.scale;
  zoom.value = Math.round(scale * 100);
  app.camera.setViewport({
    x: rect.width / 2 - wx * scale,
    y: rect.height / 2 - wy * scale,
    scale,
  });
  app.requestCameraRender();
}

// 渲染文档后自动适应视图：整棵导图落入视口并居中。仅缩小不放大（缩放上限 100%）：
// 视口插件的 fit 允许放大到 8 倍，节点少的小导图会被放大到数百百分比，文档载入
// 场景按原尺寸居中即可；工具栏手动「适应视图」保持可放大语义
function fitScene() {
  if (!mindmap) return;
  mindmap.fit();
  if (app.camera.scale > 1) setZoom(1);
}

// 缩放滑块：以画布中心为锚点缩放，范围与滚轮缩放一致（0.2–8）
function onZoomInput(event: Event) {
  setZoom(Number((event.target as HTMLInputElement).value) / 100);
}

// 滑块轨道填充：滑块左侧为紫色已填充段（与 AI 侧边栏同色），右侧为浅色剩余段
const zoomTrackStyle = computed(() => {
  const pct = ((zoom.value - 20) / (800 - 20)) * 100;
  return {
    background: `linear-gradient(to right, #8b5cf6 ${pct}%, #e5e7eb ${pct}%)`,
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

// 拉取文档列表（dialog 内展示，排序由 sortedDocs 决定）
function refreshDocs() {
  return listDocs().then((all) => {
    docs.value = all;
  });
}

// 把当前场景数据落盘到当前文档（文档名取根节点文本，布局方向与连线样式随档保存）。
// 与上次落盘内容逐字段对比，完全相等则跳过：打开即触发、改后撤销回原样都不会误更新
function snapshotOf(
  data: MindMapNode,
  direction: LayoutDirection,
  edgeStyle: EdgeShape,
) {
  return JSON.stringify([data, direction, edgeStyle]);
}

function saveCurrent() {
  if (!mindmap || !currentId.value) return;
  const data = mindmap.toJSON();
  const snapshot = snapshotOf(data, layout.value, edge.value);
  if (snapshot === lastSaved) return;
  docName.value = data.text;
  void putDoc({
    id: currentId.value,
    name: docName.value,
    data,
    direction: layout.value,
    edgeStyle: edge.value,
    createdAt: docCreatedAt,
    updatedAt: Date.now(),
  }).then(() => {
    lastSaved = snapshot;
    return refreshDocs();
  });
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

// 切换/新建/关闭前立刻落盘：取消待保存的定时器，此时 currentId 尚未变更，归属正确；
// 内容与上次落盘相等时 saveCurrent 内部会跳过，不会产生空更新
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveCurrent();
}

// 挂载场景：宿主 App 与官方插件复用（MindMap.destroy 对称拆卸自有插件与
// 场景节点，App 不受影响），销毁旧门面后以新数据重建，实现打开/新建导图
function mountScene(
  nodeData: MindMapNode,
  direction: LayoutDirection,
  shape: EdgeShape,
) {
  mindmap?.destroy();
  mindmap = new MindMap({
    app,
    data: nodeData,
    direction,
    edgeStyle: shape,
    levelStyles,
    // AI 编辑生成适配器（OpenAI 兼容接口，配置见面板设置弹层）
    ai: realGenerate,
    // 数据变化（新增/删除/移动/文本编辑/折叠/布局/连线/AI 编辑）时同步工具条并自动保存；
    // 挂载还原触发的 onChange 由 saveCurrent 的内容对比兜底，不会误写库
    onChange: () => {
      syncToolbar();
      scheduleSave();
    },
  });
  syncToolbar();
  // 新建/切换导图自动适应视图，随后激活根节点（selectRoot 等待异步初始化
  // 完成后再执行 fitScene，此时整棵树已布局、包围盒可用）
  void mindmap.selectRoot().then(() => fitScene());
  // 临时调试：暴露实例供浏览器自动化测试定位节点（验证后移除）
  (window as any).__mindmap = mindmap;
}

// 新建导图：先落盘当前文档，再以新 id 建档并重建场景；initial 为首档示例数据
function createNew(initial?: MindMapNode) {
  docsOpen.value = false;
  flushSave();
  const now = Date.now();
  const docData = initial ?? { text: "中心主题", children: [] };
  const doc: MindMapDoc = {
    id: crypto.randomUUID(),
    name: docData.text,
    data: docData,
    direction: layout.value,
    edgeStyle: edge.value,
    createdAt: now,
    updatedAt: now,
  };
  currentId.value = doc.id;
  docName.value = doc.name;
  docCreatedAt = now;
  lastSaved = snapshotOf(docData, doc.direction, doc.edgeStyle);
  void putDoc(doc).then(refreshDocs);
  clearAiChat();
  mountScene(doc.data, doc.direction, doc.edgeStyle);
}

// 打开指定文档：先落盘当前文档，再按档内偏好（方向/连线）还原场景
async function openDoc(id: string) {
  if (id === currentId.value) {
    docsOpen.value = false;
    return;
  }
  docsOpen.value = false;
  flushSave();
  const doc = await getDoc(id);
  if (!doc) return;
  currentId.value = doc.id;
  docName.value = doc.name;
  docCreatedAt = doc.createdAt;
  layout.value = doc.direction;
  edge.value = doc.edgeStyle;
  lastSaved = snapshotOf(doc.data, doc.direction, doc.edgeStyle);
  clearAiChat();
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

  // 显式装配：自建 App 并安装官方插件预设（集合与顺序的单一事实来源在 @silkor/preset），
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
  const latest = docs.value.reduce<(typeof docs.value)[number] | null>(
    (acc, d) => (!acc || d.updatedAt > acc.updatedAt ? d : acc),
    null,
  );
  if (latest) {
    currentId.value = latest.id;
    docName.value = latest.name;
    docCreatedAt = latest.createdAt;
    layout.value = latest.direction;
    edge.value = latest.edgeStyle;
    lastSaved = snapshotOf(latest.data, latest.direction, latest.edgeStyle);
    mountScene(latest.data, latest.direction, latest.edgeStyle);
  } else {
    // 首次使用：以示例数据创建首个文档
    createNew(data);
  }
});

onUnmounted(() => {
  window.removeEventListener("beforeunload", flushSave);
  closeMenu();
  flushSave();
  mindmap?.destroy();
  mindmap = null;
});
</script>

<template>
  <!-- 图标精灵表（隐藏挂载一次，全组件按 name 引用 symbol） -->
  <IconSprites />
  <!-- 整体布局：画布区（flex-1）与 AI 侧边栏并列，侧边栏为布局元素而非悬浮层 -->
  <div class="flex h-screen w-screen overflow-hidden">
    <!-- 画布区：悬浮控件锚定于此容器，宽度随侧边栏开合自动伸缩 -->
    <div class="relative min-w-0 flex-1">
      <canvas ref="canvasRef" class="block h-full w-full bg-white"></canvas>

      <!-- 文档切换器：标题按钮 + 新建按钮共用一个悬浮底座 -->
      <div
        class="absolute top-4 left-4 z-10 flex items-center gap-0.5 rounded-lg bg-white p-1 shadow-[0_2px_8px_rgba(0,0,0,0.1)]"
      >
        <button
          class="flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 hover:bg-gray-100"
          title="导图列表"
          @click="docsOpen = true"
        >
          <Icon name="i-file" class="h-4 w-4 text-gray-500" />
          <span class="max-w-40 truncate text-xs text-gray-800">
            {{ docName || "未命名标题" }}
          </span>
          <Icon name="i-chevron-down" class="h-3 w-3 text-gray-400" />
        </button>
        <button
          class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-gray-800 hover:bg-gray-100"
          title="新建导图"
          aria-label="新建导图"
          @click="createNew()"
        >
          <Icon name="i-plus" class="h-4 w-4" />
        </button>
      </div>

      <!-- 单一胶囊工具条：撤销/重做可点击，其余项悬浮展开选项面板 -->
      <div
        class="absolute top-4 right-4 z-10 flex items-center gap-0.5 rounded-lg bg-white p-1 shadow-[0_2px_8px_rgba(0,0,0,0.1)]"
      >
        <button
          class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
          :disabled="!canUndo"
          title="撤销"
          aria-label="撤销"
          @click="undo"
        >
          <Icon name="i-undo" class="block h-4 w-4" />
        </button>
        <button
          class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300"
          :disabled="!canRedo"
          title="重做"
          aria-label="重做"
          @click="redo"
        >
          <Icon name="i-redo" class="block h-4 w-4" />
        </button>
        <span class="mx-0.5 h-4 w-px bg-gray-200"></span>

        <!-- 布局方向设置：横向（right）/ 左向（left）/ 双向平衡（both）/ 组织结构图（down） -->
        <div
          class="relative"
          @mouseenter="scheduleMenu('layout')"
          @mouseleave="closeMenu"
        >
          <button
            class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100"
            title="布局方向"
          >
            <Icon :name="layoutIcons[layout]" class="block h-4 w-4" />
          </button>
          <div
            class="absolute top-[calc(100%+10px)] right-0 z-20 flex-col items-center gap-0.5 rounded-lg bg-white p-1 shadow-[0_4px_16px_rgba(0,0,0,0.12)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-['']"
            :class="openMenu === 'layout' ? 'flex' : 'hidden'"
          >
            <button
              v-for="opt in layoutOptions"
              :key="opt.value"
              class="flex h-14 w-14 cursor-pointer items-center justify-center rounded-md text-sm text-gray-500 hover:bg-gray-100"
              :class="{ 'bg-[#ede9fe] text-violet-700': layout === opt.value }"
              :title="opt.title"
              @click="pickLayout(opt.value)"
            >
              <Icon :name="layoutIcons[opt.value]" class="h-9 w-9" />
            </button>
          </div>
        </div>

        <!-- 连线形状设置 -->
        <div
          class="relative"
          @mouseenter="scheduleMenu('edge')"
          @mouseleave="closeMenu"
        >
          <button
            class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100"
            title="连线形状"
          >
            <Icon :name="edgeIcons[edge]" class="block h-4 w-4" />
          </button>
          <div
            class="absolute top-[calc(100%+10px)] right-0 z-20 flex-col items-center gap-0.5 rounded-lg bg-white p-1 shadow-[0_4px_16px_rgba(0,0,0,0.12)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-['']"
            :class="openMenu === 'edge' ? 'flex' : 'hidden'"
          >
            <button
              v-for="opt in edgeOptions"
              :key="opt.value"
              class="flex h-14 w-14 cursor-pointer items-center justify-center rounded-md text-sm text-gray-500 hover:bg-gray-100"
              :class="{ 'bg-[#ede9fe] text-violet-700': edge === opt.value }"
              :title="opt.title"
              @click="pickEdge(opt.value)"
            >
              <Icon :name="edgeIcons[opt.value]" class="h-9 w-9" />
            </button>
          </div>
        </div>
        <button
          class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100"
          title="适应视图"
          aria-label="适应视图"
          @click="fit"
        >
          <Icon name="i-fit" class="block h-4 w-4" />
        </button>
        <button
          class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100"
          title="居中"
          aria-label="居中"
          @click="center"
        >
          <Icon name="i-center" class="block h-4 w-4" />
        </button>
        <span class="mx-0.5 h-4 w-px bg-gray-200"></span>

        <!-- 导出：复制 JSON / 下载 JSON / 导出图片 -->
        <div
          class="relative"
          @mouseenter="scheduleMenu('export')"
          @mouseleave="closeMenu"
        >
          <button
            class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100"
            title="导出"
          >
            <Icon name="i-export" class="block h-4 w-4" />
          </button>
          <div
            class="absolute top-[calc(100%+10px)] right-0 z-20 min-w-28 flex-col rounded-lg bg-white p-1 shadow-[0_4px_16px_rgba(0,0,0,0.12)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-['']"
            :class="openMenu === 'export' ? 'flex' : 'hidden'"
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
        <div
          class="relative"
          @mouseenter="scheduleMenu('zoom')"
          @mouseleave="closeMenu"
        >
          <button
            class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm text-gray-800 hover:bg-gray-100"
            title="缩放"
          >
            <span class="text-[11px] tabular-nums">{{ zoom }}</span>
          </button>
          <div
            class="absolute top-[calc(100%+10px)] right-0 z-20 min-w-45 flex-col items-center rounded-lg bg-white px-3.5 py-2.5 shadow-[0_4px_16px_rgba(0,0,0,0.12)] before:absolute before:inset-x-0 before:-top-2.5 before:h-2.5 before:content-['']"
            :class="openMenu === 'zoom' ? 'flex' : 'hidden'"
          >
            <input
              class="h-1 w-35 cursor-pointer appearance-none rounded-full outline-none [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:cursor-grab [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
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

        <!-- AI 侧边栏开关 -->
        <button
          class="flex h-8 w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md text-sm hover:bg-gray-100"
          :class="aiSidebarOpen ? 'text-violet-500' : 'text-gray-800'"
          title="AI 助手"
          @click="aiSidebarOpen = !aiSidebarOpen"
        >
          <Icon name="i-sparkles" class="block h-4 w-4" />
        </button>
      </div>
    </div>

    <!-- AI 助手侧边栏：布局内并列面板（非悬浮层），历史消息保留（用户指令 / AI 回答 / 执行反馈 / 思考过程） -->
    <div
      v-if="aiSidebarOpen"
      class="flex h-full w-90 shrink-0 flex-col border-l border-gray-100 bg-white"
    >
      <!-- 头部 -->
      <div class="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
        <Icon name="i-sparkles" class="h-4 w-4 text-violet-500" />
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
          <Icon name="i-settings" class="h-4 w-4" />
        </button>
        <button
          class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100"
          title="收起"
          @click="aiSidebarOpen = false"
        >
          <Icon name="i-chevron-down" class="h-4 w-4" />
        </button>
      </div>

      <!-- 服务配置（localStorage 持久化） -->
      <div
        v-if="aiSettingsOpen"
        class="flex flex-col gap-2 border-b border-gray-100 bg-gray-50 p-3"
      >
        <select
          v-model="aiConfig.format"
          class="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-800 outline-none focus:border-violet-400"
        >
          <option value="openai">OpenAI 兼容格式（chat/completions）</option>
          <option value="anthropic">Anthropic 格式（messages）</option>
        </select>
        <input
          v-model="aiConfig.baseURL"
          class="h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-xs outline-none focus:border-violet-400"
          :placeholder="
            aiConfig.format === 'anthropic'
              ? '接口地址（含 /v1），如 https://api.anthropic.com/v1'
              : '接口地址（含 /v1），如 https://api.deepseek.com/v1'
          "
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
          :placeholder="
            aiConfig.format === 'anthropic'
              ? '模型名，如 claude-sonnet-4-5'
              : '模型名，如 deepseek-chat'
          "
        />
        <div class="flex items-center justify-between">
          <span class="text-[10px] text-gray-400"
            >保存在浏览器本地；服务端需允许跨域或走本地代理</span
          >
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
        <div
          v-if="!aiMessages.length && !aiPending"
          class="mt-10 text-center text-xs leading-5 text-gray-400"
        >
          输入编辑指令或提问，如：<br />围绕前端展开 / 把矩阵移到线性代数下 /
          这个导图讲了什么<br />
          撤销上一步 / 重做 / 我刚才改了什么<br />同名节点用路径定位，如
          "线性代数/矩阵"
        </div>

        <div v-for="m in aiMessages" :key="m.id">
          <!-- 用户指令：右侧气泡 -->
          <div v-if="m.role === 'user'" class="flex justify-end">
            <div
              class="max-w-[85%] rounded-xl rounded-br-sm bg-violet-500 px-3 py-2 text-xs leading-5 text-white"
            >
              {{ m.text }}
            </div>
          </div>
          <!-- 错误 -->
          <div
            v-else-if="m.role === 'error'"
            class="text-xs leading-5 text-red-500"
          >
            {{ m.text }}
          </div>
          <!-- AI 回复：思考过程（可折叠）+ 回答 + 执行反馈链 -->
          <div v-else class="flex flex-col gap-2">
            <details
              v-if="m.reasoning"
              class="rounded-lg bg-gray-50 px-2.5 py-1.5"
            >
              <summary class="cursor-pointer text-xs text-gray-400 select-none">
                思考过程
              </summary>
              <div
                class="mt-1 text-[11px] leading-5 whitespace-pre-wrap text-gray-400"
              >
                {{ m.reasoning }}
              </div>
            </details>
            <!-- Markdown 为 async setup 组件，须置于 Suspense 内；操作 JSON 形态的
                 原文（模型坏 JSON 时控制器整体作为回答返回）退回纯文本展示 -->
            <Suspense v-if="m.text && !isOpsStream(m.text)">
              <Markdown
                :value="m.text"
                class="ai-md text-xs leading-5 text-gray-600"
              />
            </Suspense>
            <div
              v-else-if="m.text"
              class="text-xs leading-5 whitespace-pre-wrap text-gray-600"
            >
              {{ m.text }}
            </div>
            <div v-if="m.steps?.length" class="flex flex-col gap-1">
              <div
                v-for="(s, i) in m.steps"
                :key="i"
                class="flex items-start gap-1.5 text-xs leading-5"
              >
                <span
                  :class="
                    s.status === 'applied'
                      ? 'text-emerald-500'
                      : 'text-gray-300'
                  "
                  >{{ s.status === "applied" ? "✓" : "–" }}</span
                >
                <span
                  :class="
                    s.status === 'applied' ? 'text-gray-600' : 'text-gray-400'
                  "
                  >{{ s.label }}</span
                >
              </div>
            </div>
          </div>
        </div>

        <!-- 进行中：流式思考实时展示；回答文本经 comark 流式渲染（编辑类 JSON
             输出只显示占位，等解析完成后以反馈链展示） -->
        <div v-if="aiPending" class="flex flex-col gap-2">
          <details
            v-if="aiPending.reasoning"
            open
            class="rounded-lg bg-gray-50 px-2.5 py-1.5"
          >
            <summary class="cursor-pointer text-xs text-gray-400 select-none">
              思考中…
            </summary>
            <div
              class="mt-1 text-[11px] leading-5 whitespace-pre-wrap text-gray-400"
            >
              {{ aiPending.reasoning }}
            </div>
          </details>
          <Suspense v-if="aiPending.content && !isOpsStream(aiPending.content)">
            <Markdown
              :value="aiPending.content"
              streaming
              :caret="{ class: 'comark-caret' }"
              class="ai-md text-xs leading-5 text-gray-600"
            />
          </Suspense>
          <div
            v-else-if="!aiPending.reasoning"
            class="flex items-center gap-1.5 text-xs text-gray-400"
          >
            <Icon name="i-sparkles" class="h-3.5 w-3.5 animate-pulse text-violet-400" />
            {{ isOpsStream(aiPending.content) ? "执行操作中…" : "思考中…" }}
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="flex items-center gap-2 border-t border-gray-100 p-2.5">
        <input
          v-model="aiPrompt"
          class="h-9 min-w-0 flex-1 rounded-lg bg-gray-50 px-3 text-sm text-gray-800 outline-none placeholder:text-gray-400"
          placeholder="输入指令或提问…"
          @keydown.enter="sendAi"
        />
        <!-- 空闲时发送（向上箭头）；生成中变停止按钮，点击中止本次 AI 请求 -->
        <button
          class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white disabled:cursor-not-allowed disabled:opacity-50"
          :class="
            aiBusy ? 'bg-gray-900 hover:bg-gray-700' : 'bg-violet-500 hover:bg-violet-600'
          "
          :disabled="!aiBusy && !aiPrompt.trim()"
          :title="aiBusy ? '停止生成' : '发送'"
          :aria-label="aiBusy ? '停止生成' : '发送'"
          @click="aiBusy ? stopAi() : sendAi()"
        >
          <Icon v-if="aiBusy" name="i-stop" class="h-3.5 w-3.5" />
          <Icon v-else name="i-arrow-up" class="h-4 w-4" />
        </button>
      </div>
    </div>
  </div>

  <!-- 文档 dialog：遮罩点击关闭，列表按创建/更新时间排序，点击条目打开导图 -->
  <Teleport to="body">
    <Transition name="dialog">
      <div
        v-if="docsOpen"
        class="fixed inset-0 z-30 flex items-center justify-center bg-gray-900/30 p-4 backdrop-blur-[2px]"
        @click.self="docsOpen = false"
      >
        <div
          class="dialog-panel flex max-h-[70vh] w-96 flex-col overflow-hidden rounded-2xl bg-white shadow-[0_16px_48px_rgba(0,0,0,0.18)] ring-1 ring-black/5"
          role="dialog"
          aria-label="导图列表"
        >
          <!-- 头部：标题 + 数量徽标 + 关闭 -->
          <div
            class="flex items-center gap-2 border-b border-gray-100 px-5 py-3.5"
          >
            <span class="text-sm font-semibold text-gray-900">我的导图</span>
            <span
              class="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] leading-4 text-gray-500"
            >
              {{ sortedDocs.length }}
            </span>
            <button
              class="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              title="关闭"
              aria-label="关闭"
              @click="docsOpen = false"
            >
              <Icon name="i-close" class="h-3.5 w-3.5" />
            </button>
          </div>

          <!-- 排序：分段控件，点击切换升降序 -->
          <div class="px-4 pt-3">
            <div class="inline-flex items-center rounded-lg bg-gray-100 p-0.5">
              <button
                v-for="key in ['createdAt', 'updatedAt'] as const"
                :key="key"
                class="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2.5 text-[11px] transition-all"
                :class="
                  sortKey === key
                    ? 'bg-white font-medium text-gray-800 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                "
                @click="sortKey === key ? (sortAsc = !sortAsc) : (sortKey = key)"
              >
                {{ key === "createdAt" ? "创建时间" : "更新时间" }}
                <span v-if="sortKey === key" class="text-[9px]">{{
                  sortAsc ? "↑" : "↓"
                }}</span>
              </button>
            </div>
          </div>

          <!-- 导图列表 -->
          <div
            class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 py-2.5"
          >
            <div
              v-for="d in sortedDocs"
              :key="d.id"
              class="group/row flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-colors"
              :class="
                d.id === currentId
                  ? 'bg-violet-50 ring-1 ring-violet-100'
                  : 'hover:bg-gray-50'
              "
              @click="openDoc(d.id)"
            >
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                :class="
                  d.id === currentId
                    ? 'bg-violet-100 text-violet-600'
                    : 'bg-gray-100 text-gray-400'
                "
              >
                <Icon name="i-file" class="h-4 w-4" />
              </span>
              <div class="min-w-0 flex-1">
                <div
                  class="truncate text-[13px] font-medium"
                  :class="
                    d.id === currentId
                      ? 'text-violet-700'
                      : 'text-gray-800'
                  "
                >
                  {{ d.name }}
                </div>
                <div class="text-[11px] text-gray-400">
                  更新于 {{ formatTime(d.updatedAt) }}
                </div>
              </div>
              <button
                class="hidden h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500 group-hover/row:flex"
                title="删除"
                aria-label="删除"
                @click.stop="removeDoc(d.id)"
              >
                <Icon name="i-trash" class="h-3.5 w-3.5" />
              </button>
            </div>
            <div v-if="!sortedDocs.length" class="py-10 text-center">
              <Icon name="i-file" class="mx-auto mb-2 h-8 w-8 text-gray-200" />
              <div class="text-xs text-gray-400">还没有导图，点击下方按钮新建</div>
            </div>
          </div>

          <!-- 底部：新建 -->
          <div class="border-t border-gray-100 p-3">
            <button
              class="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-violet-500 text-xs font-medium text-white transition-colors hover:bg-violet-600"
              @click="createNew()"
            >
              <Icon name="i-plus" class="h-3.5 w-3.5" />
              新建导图
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* dialog 进出场：遮罩淡入淡出，面板上浮缩放 */
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity 0.2s ease;
}
.dialog-enter-active .dialog-panel,
.dialog-leave-active .dialog-panel {
  transition:
    transform 0.2s ease,
    opacity 0.2s ease;
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-from .dialog-panel,
.dialog-leave-to .dialog-panel {
  transform: translateY(8px) scale(0.97);
  opacity: 0;
}
</style>
