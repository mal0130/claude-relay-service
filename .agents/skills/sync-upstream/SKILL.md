---
name: sync-upstream
description: 同步上游仓库的最新版本，保留当前分支的修改，合并上游更新后推送并自动发布。当需要同步上游更新、检查上游是否有新版本时使用。
---

# 同步上游版本

拉取上游仓库的最新代码并合并到当前分支，保留当前分支的本地修改不被删除。

## 使用说明

当用户调用此 skill 时，直接执行项目中的 `scripts/sync-upstream.sh` 脚本。该脚本已经实现了完整的同步流程。

### 执行步骤

1. **完整同步流程**（默认）：
   ```bash
   bash scripts/sync-upstream.sh
   ```

   脚本会自动执行：
   - 检查并配置 upstream 远程仓库
   - 获取上游最新代码
   - 比较本地和上游版本号
   - 显示版本变化和文件变更统计
   - 显示上游最近的提交记录
   - 询问用户是否合并更新
   - 检查本地是否有未提交的修改（stash 保存后合并再还原）
   - 合并上游更新（保留本地修改，处理冲突）
   - 推送到远程仓库
   - 显示 GitHub Actions 构建信息

2. **仅检查更新**（不合并）：
   ```bash
   bash scripts/sync-upstream.sh --check-only
   ```

   只检查版本和显示变更，不执行合并操作。

## 何时使用此 skill

此 skill 适用于以下场景：
- 同步上游仓库的更新
- 检查上游是否有新版本
- 合并上游代码（保留本地修改）
- 处理合并冲突
- 自动发布新版本

## 前置条件

脚本会自动检查并配置 upstream 远程仓库：
- 仓库 URL: https://github.com/Wei-Shaw/Codex-relay-service.git
- 如果未配置会自动添加

## 使用示例

```bash
# 完整同步流程
/sync-upstream

# 仅检查更新，不合并
/sync-upstream --check-only
```

## 注意事项

- 合并时会保留当前分支的本地修改，不会被上游覆盖删除
- 如果有本地未提交的修改，脚本会自动 stash 保存，合并完成后还原
- 如果合并时出现冲突，脚本会显示冲突文件并提示手动解决
- VERSION 文件会自动更新为上游版本
- 推送完成后，GitHub Actions 会自动构建前端、创建 tag 和 Release
- 在服务器上执行 `crs update` 即可更新到最新版本
