// AI 目标定位测试：路径定位、序号消歧、多同名歧义、批内候选合并。
// 定位纯函数只消费 text/children/parent/id，用最小桩对象即可（免 DOM 依赖）。
import { describe, expect, it } from "vitest";
import type { Text } from "@silker/core";
import {
  AIEditingController,
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

describe("AIEditingController.compile：批内 move + delete 的连线清理", () => {
  // 回归：a → x → b → c，AI 先 move b 到 a 下、再 delete x。
  // delete 的死连线必须在 redo 时按当时树状态计算——编译期 b 仍在 x 子树内，
  // 若按编译期收集会把 b 子树自身的 b→c 连线误判为死连线，redo 时被错误删除
  // 且不再恢复（表现为连线消失、刷新后才回来）
  const fakeText = (id: string, text: string, children: any[] = []): any => {
    const node: any = {
      id,
      text,
      children,
      parent: null,
      collapsed: false,
      visible: true,
      attachChild(child: any, index?: number) {
        child.parent = node;
        node.children.splice(index ?? node.children.length, 0, child);
      },
      remove(child: any) {
        const i = node.children.indexOf(child);
        if (i >= 0) node.children.splice(i, 1);
        child.parent = null;
      },
    };
    children.forEach((c) => (c.parent = node));
    return node;
  };
  const fakeEdge = (id: string, fromNode: any, toNode: any) => ({
    id,
    fromNode,
    toNode,
  });

  function setup() {
    const a = fakeText("a", "A");
    const x = fakeText("x", "X");
    const b = fakeText("b", "B");
    const c = fakeText("c", "C");
    a.attachChild(x);
    x.attachChild(b);
    b.attachChild(c);
    const eAX = fakeEdge("e-ax", a, x);
    const eXB = fakeEdge("e-xb", x, b);
    const eBC = fakeEdge("e-bc", b, c);
    const model: any = {
      root: a,
      edges: [eAX, eXB, eBC],
      levelStyles: [],
      nodeStyles: new WeakMap(),
      customStyles: new WeakMap(),
      styleOf: () => ({}),
      customStyleOf: () => ({}),
      nodeById: (id: string) => [a, x, b, c].find((t) => t.id === id) ?? null,
      // compile 用树索引快照替代逐次 nodeById（见 ai-controller.ts），桩按同语义实现
      indexById: () => {
        const map = new Map<string, any>();
        [a, x, b, c].forEach((t) => map.set(t.id, t));
        return map;
      },
      depthOf: (node: any) => {
        let d = 0;
        let p = node.parent;
        while (p) {
          d++;
          p = p.parent;
        }
        return d;
      },
      levelStyle: () => ({}),
      applyCollapseVisibility: () => {},
      applyNodeStyle: () => {},
      // move 落点在折叠节点下时 ai 编译路径会先展开目标（同 add 纪律，见 ai.ts）
      expand: () => {},
      // move 命令换线走连线原语（见 commands.ts 换父纪律）：桩实现真实挂载/摘除语义
      mountEdges: (es: any[]) => {
        model.edges.push(...es);
      },
      unmountEdges: (es: any[]) => {
        const gone = new Set(es);
        model.edges = model.edges.filter((e: any) => !gone.has(e));
      },
      createEdge: (from: any, to: any) => fakeEdge(`e-${from.id}-${to.id}`, from, to),
      serializeForHistory: (node: any): any => ({
        id: node.id,
        text: node.text,
        children: node.children.map((ch: any) => model.serializeForHistory(ch)),
      }),
    };
    const deps = {
      app: { add: () => {}, remove: () => {} },
      model,
      history: { exec: () => {}, exportJSON: () => null },
      undo: async () => true,
      redo: async () => true,
      editor: { bind: () => {} },
      sel: { items: [] },
      activation: {
        active: null,
        activate: () => {},
        deactivate: () => {},
        editing: false,
      },
      onRelayout: () => {},
      emitChange: () => {},
    };
    const ctrl = new AIEditingController(deps as any, null);
    return { a, x, b, c, eAX, eXB, eBC, model, ctrl };
  }

  it("move b 到 a 下后 delete x：b→c 连线保留，仅 x 及其连线被清理", () => {
    const { a, x, b, c, eAX, eXB, eBC, model, ctrl } = setup();
    const { commands } = (ctrl as any).compile(
      [
        { op: "move", target: "b", parent: "a" },
        { op: "delete", target: "x" },
      ],
      "a",
    );
    // 模拟 exec：组合命令按序 redo
    commands.forEach((cmd: any) => cmd.redo());
    // 结构：b 移入 a，x 被删除，b 的子树完整保留
    expect(a.children).toEqual([b]);
    expect(b.children).toEqual([c]);
    expect(c.parent).toBe(b);
    expect(x.parent).toBeNull();
    // 连线：仅 a→b 新增、a→x / x→b 清理，b→c 不受影响
    expect(model.edges).toEqual([eBC, expect.objectContaining({ fromNode: a, toNode: b })]);
    expect(model.edges).not.toContain(eAX);
    expect(model.edges).not.toContain(eXB);
  });

  it("同一命令整体 undo：结构与连线完整还原", () => {
    const { a, x, b, c, eAX, eXB, eBC, model, ctrl } = setup();
    const { commands } = (ctrl as any).compile(
      [
        { op: "move", target: "b", parent: "a" },
        { op: "delete", target: "x" },
      ],
      "a",
    );
    commands.forEach((cmd: any) => cmd.redo());
    // 组合命令 undo 逆序回放
    [...commands].reverse().forEach((cmd: any) => cmd.undo());
    expect(a.children).toEqual([x]);
    expect(x.children).toEqual([b]);
    expect(b.children).toEqual([c]);
    expect(model.edges).toEqual([eBC, eAX, eXB]);
  });
});
