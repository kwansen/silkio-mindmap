// AI 目标定位测试：路径定位、序号消歧、多同名歧义、批内候选合并。
// 定位纯函数只消费 text/children/parent/id，用最小桩对象即可（免 DOM 依赖）。
import { describe, expect, it } from "vitest";
import type { Text } from "@silker/core";
import {
  collectTargetCandidates,
  describeHistoryCommand,
  matchTargetSegment,
  nodePath,
  normalizeAIOps,
  normalizeRenderTree,
  parseAIResponse,
  parseTargetSegment,
  resolveTargetByPath,
} from "../src/ai";

// 最小节点桩：id + text + children + parent（定位函数的全部依赖面）
const n = (id: string, text: string, children: any[] = []): any => {
  const node: any = { id, text, children, parent: null };
  children.forEach((c) => (c.parent = node));
  return node;
};

// 线性代数（根） → 矩阵[m1] > 行列式[d1]，矩阵[m2]，向量组[v] > 矩阵[m3]
// 「矩阵」三处同名，覆盖歧义场景
const root: Text = n("r", "线性代数", [
  n("m1", "矩阵", [n("d1", "行列式")]),
  n("m2", "矩阵"),
  n("v", "向量组", [n("m3", "矩阵")]),
]) as Text;

describe("AI 目标定位", () => {
  it("nodePath：根起路径拼接", () => {
    expect(nodePath(root.children[2].children[0])).toBe("线性代数/向量组/矩阵");
  });

  it("parseTargetSegment：纯文本与 [n] 序号", () => {
    expect(parseTargetSegment("矩阵")).toEqual({ text: "矩阵", nth: 1 });
    expect(parseTargetSegment("矩阵[2]")).toEqual({ text: "矩阵", nth: 2 });
    expect(parseTargetSegment("A[0]")).toEqual({ text: "A", nth: 1 }); // 非法序号归 1
  });

  it("matchTargetSegment：先序命中同名节点的第 n 个", () => {
    const cands = collectTargetCandidates(root);
    expect(matchTargetSegment(cands, "矩阵[2]")).toBe(cands[3]);
    expect(matchTargetSegment(cands, "矩阵[3]")).toBe(cands[5]);
    expect(matchTargetSegment(cands, "矩阵[4]")).toBeNull();
  });

  it("resolveTargetByPath：斜杠路径逐段下钻，可混用序号", () => {
    expect(resolveTargetByPath(root, "线性代数/向量组/矩阵")?.id).toBe("m3");
    expect(resolveTargetByPath(root, "线性代数/矩阵[2]")?.id).toBe("m2");
    expect(resolveTargetByPath(root, "线性代数/不存在")).toBeNull();
  });

  it("collectTargetCandidates：批内新建节点并入候选尾部", () => {
    const extra = [n("s1", "矩阵")];
    const cands = collectTargetCandidates(root, extra);
    expect(cands[cands.length - 1]).toBe(extra[0]);
    expect(cands.filter((x) => x.text === "矩阵")).toHaveLength(4);
  });
});

describe("AI render 整树重渲染", () => {
  it("normalizeRenderTree：children 缺省补空数组，缺 text 即抛错", () => {
    expect(normalizeRenderTree({ text: "根", children: [{ text: "叶" }] })).toEqual({
      text: "根",
      children: [{ text: "叶", children: [] }],
    });
    expect(() => normalizeRenderTree({ children: [] })).toThrow();
    expect(() => normalizeRenderTree({ text: "", children: [] })).toThrow();
    expect(() => normalizeRenderTree(null)).toThrow();
  });

  it("parseAIResponse：裸树对象整体识别为 render 操作", () => {
    const { ops, answer } = parseAIResponse(
      JSON.stringify({ text: "新根", children: [{ text: "A" }] }),
    );
    expect(answer).toBeUndefined();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "render",
      tree: { text: "新根", children: [{ text: "A", children: [] }] },
    });
  });

  it("parseAIResponse：操作数组内的 render 透传，answer 对象不误判为 render", () => {
    const ops = parseAIResponse(
      JSON.stringify([{ op: "render", tree: { text: "根", children: [] } }]),
    ).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "render" });

    const answered = parseAIResponse(JSON.stringify({ answer: "讲的是线性代数" }));
    expect(answered.ops).toHaveLength(0);
    expect(answered.answer).toBe("讲的是线性代数");
  });
});

describe("AI undo/redo/history 操作", () => {
  it("normalizeAIOps：无载荷操作放行，不再报未知操作类型", () => {
    expect(
      normalizeAIOps([{ op: "undo" }, { op: "redo" }, { op: "history" }]),
    ).toEqual([{ op: "undo" }, { op: "redo" }, { op: "history" }]);
    // 与编辑类操作共存时仍能通过规整（混用拒绝在控制器 run 层）
    expect(
      normalizeAIOps([{ op: "history" }, { op: "edit", text: "新文本" }]),
    ).toHaveLength(2);
  });

  it("parseAIResponse：undo/redo/history 保留在 ops 中", () => {
    const { ops, answer } = parseAIResponse(
      JSON.stringify([{ op: "undo" }, { op: "undo" }, { op: "redo" }]),
    );
    expect(answer).toBeUndefined();
    expect(ops.map((o) => o.op)).toEqual(["undo", "undo", "redo"]);
  });
});

describe("describeHistoryCommand：序列化命令的可读描述", () => {
  // 最小模型桩：仅实现 describeHistoryCommand 的依赖面 nodeById
  const model = {
    nodeById: (id: string) =>
      ({ p: { text: "前端" }, np: { text: "后端" } } as any)[id] ?? null,
  };

  it("mindmap.text：改名描述取载荷前后文本", () => {
    expect(
      describeHistoryCommand(
        { kind: "mindmap.text", payload: { nodeId: "x", before: "测试", after: "质量保障" } },
        model,
      ),
    ).toBe("将「测试」改为「质量保障」");
  });

  it("mindmap.add/move：节点文本经模型按 id 解析，查不到退化为占位文本", () => {
    expect(
      describeHistoryCommand(
        { kind: "mindmap.add", payload: { parentId: "p", node: { text: "React" } } },
        model,
      ),
    ).toBe("在「前端」下添加「React」");
    expect(
      describeHistoryCommand(
        {
          kind: "mindmap.move",
          payload: { moves: [{ nodeId: "p", oldParentId: "p", newParentId: "np" }] },
        },
        model,
      ),
    ).toBe("将「前端」移动到「后端」下");
    expect(
      describeHistoryCommand(
        {
          kind: "mindmap.move",
          payload: { moves: [{ nodeId: "p", oldParentId: "np", newParentId: "np" }] },
        },
        model,
      ),
    ).toBe("调整「前端」的排序");
    expect(
      describeHistoryCommand(
        { kind: "mindmap.add", payload: { parentId: "gone", node: { text: "X" } } },
        model,
      ),
    ).toBe("在「（已不存在的节点）」下添加「X」");
  });

  it("composite：递归描述子命令并以分号连接", () => {
    expect(
      describeHistoryCommand(
        {
          kind: "composite",
          payload: {
            type: "ai",
            children: [
              { kind: "mindmap.text", payload: { nodeId: "x", before: "A", after: "B" } },
              { kind: "mindmap.render", payload: {} },
            ],
          },
        },
        model,
      ),
    ).toBe("将「A」改为「B」；AI 重渲染整棵导图");
  });

  it("未知 kind 退化为 kind 字符串", () => {
    expect(
      describeHistoryCommand({ kind: "thirdparty.custom", payload: null }, model),
    ).toBe("thirdparty.custom");
  });
});
