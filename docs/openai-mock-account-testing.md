# OpenAI 模拟账号本地测试

如果只是测试 `openai-usage-auto-stop` 这类调度与保护逻辑，本地不需要真的完成 OAuth。

项目里已经补了一个脚本，可以直接往本地 Redis 创建一个模拟 OpenAI 账号，并可选写入 Codex usage 快照来触发自动停调。

## 创建模拟账号

```bash
node scripts/mock-openai-account.js --name "OpenAI Mock 5h" --scenario five-hour
```

可用场景：

- `five-hour`：写入 `primaryUsedPercent=96`，触发 5 小时限额自动停调
- `weekly`：写入 `secondaryUsedPercent=96`，触发周限额自动停调
- `daily-overuse`：写入第 3 天附近超预算的周限额数据，触发日均摊自动停调
- `none`：只创建账号，不写 usage 快照

也可以手动传入 usage 值：

```bash
node scripts/mock-openai-account.js \
  --name "OpenAI Mock Custom" \
  --auto-stop-daily \
  --secondary-used 60 \
  --secondary-reset 432000 \
  --secondary-window 10080
```

## 删除模拟账号

按 ID 删除：

```bash
node scripts/mock-openai-account.js --delete <accountId>
```

按名称删除：

```bash
node scripts/mock-openai-account.js --delete-by-name "OpenAI Mock 5h"
```

## 更新模拟账号

关闭 5 小时限额自动停调：

```bash
node scripts/mock-openai-account.js \
  --update <accountId> \
  --auto-stop-five-hour false
```

更新开关并写入新的 usage 快照：

```bash
node scripts/mock-openai-account.js \
  --update <accountId> \
  --auto-stop-daily true \
  --secondary-used 60 \
  --secondary-reset 432000 \
  --secondary-window 10080
```

清理已触发的停调状态，并重新按当前 usage 判断一次：

```bash
node scripts/mock-openai-account.js \
  --update <accountId> \
  --clear-stop-state \
  --recheck-stop
```

说明：

- `--auto-stop-five-hour` / `--auto-stop-weekly` / `--auto-stop-daily` 支持显式传 `true` 或 `false`
- 只传 `--auto-stop-five-hour` 不带值时，等价于设置为 `true`
- 传入 usage 参数后，脚本会更新 Codex usage 快照
- 传入 usage 参数时，脚本会先清理旧的 usageLimit 停调状态，再按最新数据重新执行一次自动停调判断，方便本地反复调参测试

## 说明

- 这个脚本只适合本地开发环境。
- 创建的是 Redis 中的模拟 OpenAI 账号，不会真的调用 OpenAI OAuth。
- 如果你的测试需要真实上游请求，这个 mock 账号不适合；如果只是验证后台显示、调度可用性、自动停调与恢复逻辑，它就够用了。
