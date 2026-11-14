# Changesets

本仓用 [changesets](https://github.com/changesets/changesets) 管理版本与发布。

## 本地流程

1. 改完代码后，在仓根目录运行：

   ```bash
   pnpm changeset
   ```

   选择要发布的包（`silkio-mindmap`）和 bump 类型（patch / minor / major），写一条变更摘要。

2. 把生成的 `.changeset/*.md` 文件随 PR 一起提交。

3. 合入 `main` 后，GitHub Actions 的 Release workflow 会自动：
   - 有待发布 changeset 时，开一个 "chore(release): version packages" PR（自动 bump 版本、更新 CHANGELOG.md）；
   - 该 PR 合入后，构建 + 测试 + 发布到 npm。

## 注意

- `CHANGELOG.md` 由 changesets 自动维护，不要手改。
- 发布需要仓库 Secret 里的 `NPM_TOKEN`（见 Release workflow）。
