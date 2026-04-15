#!/usr/bin/env node

const openaiAccountService = require('../src/services/account/openaiAccountService')
const redis = require('../src/models/redis')

function parseArgs(argv) {
  const parsed = {
    action: 'create',
    name: 'Mock OpenAI Account',
    scenario: 'none',
    primaryUsed: null,
    primaryReset: null,
    primaryWindow: null,
    secondaryUsed: null,
    secondaryReset: null,
    secondaryWindow: null,
    autoStopOnFiveHourLimit: false,
    autoStopOnWeeklyLimit: false,
    autoStopOnDailyOveruse: false,
    hasAutoStopOnFiveHourLimit: false,
    hasAutoStopOnWeeklyLimit: false,
    hasAutoStopOnDailyOveruse: false,
    id: '',
    deleteByName: '',
    clearStopState: false,
    recheckStop: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]

    if (arg === '--help' || arg === '-h') {
      parsed.action = 'help'
    } else if (arg === '--name' && next) {
      parsed.name = next
      index += 1
    } else if (arg === '--scenario' && next) {
      parsed.scenario = next
      index += 1
    } else if (arg === '--primary-used' && next) {
      parsed.primaryUsed = Number(next)
      index += 1
    } else if (arg === '--primary-reset' && next) {
      parsed.primaryReset = Number(next)
      index += 1
    } else if (arg === '--primary-window' && next) {
      parsed.primaryWindow = Number(next)
      index += 1
    } else if (arg === '--secondary-used' && next) {
      parsed.secondaryUsed = Number(next)
      index += 1
    } else if (arg === '--secondary-reset' && next) {
      parsed.secondaryReset = Number(next)
      index += 1
    } else if (arg === '--secondary-window' && next) {
      parsed.secondaryWindow = Number(next)
      index += 1
    } else if (arg === '--auto-stop-five-hour') {
      parsed.hasAutoStopOnFiveHourLimit = true
      if (next === 'true' || next === 'false') {
        parsed.autoStopOnFiveHourLimit = next === 'true'
        index += 1
      } else {
        parsed.autoStopOnFiveHourLimit = true
      }
    } else if (arg === '--auto-stop-weekly') {
      parsed.hasAutoStopOnWeeklyLimit = true
      if (next === 'true' || next === 'false') {
        parsed.autoStopOnWeeklyLimit = next === 'true'
        index += 1
      } else {
        parsed.autoStopOnWeeklyLimit = true
      }
    } else if (arg === '--auto-stop-daily') {
      parsed.hasAutoStopOnDailyOveruse = true
      if (next === 'true' || next === 'false') {
        parsed.autoStopOnDailyOveruse = next === 'true'
        index += 1
      } else {
        parsed.autoStopOnDailyOveruse = true
      }
    } else if (arg === '--update' && next) {
      parsed.action = 'update'
      parsed.id = next
      index += 1
    } else if (arg === '--delete' && next) {
      parsed.action = 'delete'
      parsed.id = next
      index += 1
    } else if (arg === '--delete-by-name' && next) {
      parsed.action = 'deleteByName'
      parsed.deleteByName = next
      index += 1
    } else if (arg === '--clear-stop-state') {
      parsed.clearStopState = true
    } else if (arg === '--recheck-stop') {
      parsed.recheckStop = true
    }
  }

  return parsed
}

function printHelp() {
  console.log(
    `
用法:
  node scripts/mock-openai-account.js [options]

创建模拟账号:
  node scripts/mock-openai-account.js --name "OpenAI Mock 95%" --scenario five-hour
  node scripts/mock-openai-account.js --name "OpenAI Mock Weekly" --scenario weekly
  node scripts/mock-openai-account.js --name "OpenAI Mock Daily" --scenario daily-overuse

更新模拟账号:
  node scripts/mock-openai-account.js --update <accountId> --auto-stop-five-hour false
  node scripts/mock-openai-account.js --update <accountId> --auto-stop-daily true --secondary-used 60 --secondary-reset 432000 --secondary-window 10080
  node scripts/mock-openai-account.js --update <accountId> --clear-stop-state --recheck-stop

删除模拟账号:
  node scripts/mock-openai-account.js --delete <accountId>
  node scripts/mock-openai-account.js --delete-by-name "Mock OpenAI Account"

可选参数:
  --name <name>                  模拟账号名称
  --scenario <none|five-hour|weekly|daily-overuse>
  --update <accountId>           更新已有模拟账号
  --auto-stop-five-hour [bool]   设置 5 小时限额自动停止
  --auto-stop-weekly [bool]      设置周限额自动停止
  --auto-stop-daily [bool]       设置日均摊自动停止
  --primary-used <number>        x-codex-primary-used-percent
  --primary-reset <number>       x-codex-primary-reset-after-seconds
  --primary-window <number>      x-codex-primary-window-minutes
  --secondary-used <number>      x-codex-secondary-used-percent
  --secondary-reset <number>     x-codex-secondary-reset-after-seconds
  --secondary-window <number>    x-codex-secondary-window-minutes
  --clear-stop-state             清理 usageLimitAutoStopped 等停调状态
  --recheck-stop                 更新后重新执行自动停调判断
  --help                         查看帮助
`.trim()
  )
}

function buildScenarioUsage(options) {
  if (options.scenario === 'five-hour') {
    return {
      primaryUsedPercent: 96,
      primaryResetAfterSeconds: 1800,
      primaryWindowMinutes: 300
    }
  }

  if (options.scenario === 'weekly') {
    return {
      secondaryUsedPercent: 96,
      secondaryResetAfterSeconds: 3 * 24 * 60 * 60,
      secondaryWindowMinutes: 7 * 24 * 60
    }
  }

  if (options.scenario === 'daily-overuse') {
    return {
      secondaryUsedPercent: 60,
      secondaryResetAfterSeconds: 5 * 24 * 60 * 60,
      secondaryWindowMinutes: 7 * 24 * 60
    }
  }

  const usage = {}

  if (Number.isFinite(options.primaryUsed)) {
    usage.primaryUsedPercent = options.primaryUsed
  }
  if (Number.isFinite(options.primaryReset)) {
    usage.primaryResetAfterSeconds = options.primaryReset
  }
  if (Number.isFinite(options.primaryWindow)) {
    usage.primaryWindowMinutes = options.primaryWindow
  }
  if (Number.isFinite(options.secondaryUsed)) {
    usage.secondaryUsedPercent = options.secondaryUsed
  }
  if (Number.isFinite(options.secondaryReset)) {
    usage.secondaryResetAfterSeconds = options.secondaryReset
  }
  if (Number.isFinite(options.secondaryWindow)) {
    usage.secondaryWindowMinutes = options.secondaryWindow
  }

  return usage
}

async function createMockAccount(options) {
  const enableFiveHour = options.autoStopOnFiveHourLimit || options.scenario === 'five-hour'
  const enableWeekly = options.autoStopOnWeeklyLimit || options.scenario === 'weekly'
  const enableDaily = options.autoStopOnDailyOveruse || options.scenario === 'daily-overuse'

  const accountData = {
    name: options.name,
    description: 'Local mock account for OpenAI usage limit testing',
    accountType: 'shared',
    priority: 50,
    rateLimitDuration: 60,
    openaiOauth: {
      idToken: 'mock-id-token',
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      expires_in: 365 * 24 * 60 * 60
    },
    accountInfo: {
      accountId: 'mock-account-id',
      chatgptUserId: 'mock-chatgpt-user-id',
      organizationId: 'org-mock',
      organizationRole: 'owner',
      organizationTitle: 'Mock Organization',
      planType: 'plus',
      email: 'mock-openai-account@example.com',
      emailVerified: true
    },
    isActive: true,
    schedulable: true,
    autoStopOnFiveHourLimit: enableFiveHour,
    autoStopOnWeeklyLimit: enableWeekly,
    autoStopOnDailyOveruse: enableDaily
  }

  const createdAccount = await openaiAccountService.createAccount(accountData)
  const usage = buildScenarioUsage(options)

  if (Object.keys(usage).length > 0) {
    await openaiAccountService.updateCodexUsageSnapshot(createdAccount.id, usage)
    const latestAccount = await openaiAccountService.getAccount(createdAccount.id)
    await openaiAccountService.checkAndApplyUsageLimitStop(createdAccount.id, latestAccount)
  }

  const finalAccount = await openaiAccountService.getAccount(createdAccount.id)

  console.log('模拟 OpenAI 账号已创建:\n')
  console.log(`ID: ${finalAccount.id}`)
  console.log(`名称: ${finalAccount.name}`)
  console.log(`可调度: ${finalAccount.schedulable}`)
  console.log(`5小时限额自动停调: ${finalAccount.autoStopOnFiveHourLimit}`)
  console.log(`周限额自动停调: ${finalAccount.autoStopOnWeeklyLimit}`)
  console.log(`日均摊自动停调: ${finalAccount.autoStopOnDailyOveruse}`)

  if (Object.keys(usage).length > 0) {
    console.log(`primaryUsedPercent: ${finalAccount.codexPrimaryUsedPercent || '-'}`)
    console.log(`secondaryUsedPercent: ${finalAccount.codexSecondaryUsedPercent || '-'}`)
    console.log(`usageLimitAutoStopped: ${finalAccount.usageLimitAutoStopped || 'false'}`)
    console.log(`usageLimitStopReason: ${finalAccount.usageLimitStopReason || '-'}`)
    console.log(`usageLimitResumeAt: ${finalAccount.usageLimitResumeAt || '-'}`)
  }

  console.log('\n可以在管理后台的 OpenAI 账号列表中查看这个账号。')
}

function buildUpdatePayload(options) {
  const updates = {}

  if (options.hasAutoStopOnFiveHourLimit) {
    updates.autoStopOnFiveHourLimit = options.autoStopOnFiveHourLimit
  }
  if (options.hasAutoStopOnWeeklyLimit) {
    updates.autoStopOnWeeklyLimit = options.autoStopOnWeeklyLimit
  }
  if (options.hasAutoStopOnDailyOveruse) {
    updates.autoStopOnDailyOveruse = options.autoStopOnDailyOveruse
  }
  if (options.clearStopState) {
    updates.schedulable = 'true'
    updates.usageLimitAutoStopped = 'false'
    updates.usageLimitStoppedAt = ''
    updates.usageLimitStopReason = ''
    updates.usageLimitResumeAt = ''
  }

  return updates
}

async function updateMockAccount(accountId, options) {
  const account = await openaiAccountService.getAccount(accountId)
  if (!account) {
    throw new Error(`未找到账号: ${accountId}`)
  }

  const usage = buildScenarioUsage(options)
  const shouldRecheckStop = options.recheckStop || Object.keys(usage).length > 0
  const updatePayload = buildUpdatePayload(options)
  if (shouldRecheckStop) {
    updatePayload.schedulable = 'true'
    updatePayload.usageLimitAutoStopped = 'false'
    updatePayload.usageLimitStoppedAt = ''
    updatePayload.usageLimitStopReason = ''
    updatePayload.usageLimitResumeAt = ''
  }

  if (Object.keys(updatePayload).length > 0) {
    await openaiAccountService.updateAccount(accountId, updatePayload)
  }

  if (Object.keys(usage).length > 0) {
    await openaiAccountService.updateCodexUsageSnapshot(accountId, usage)
  }

  if (shouldRecheckStop) {
    const latestAccount = await openaiAccountService.getAccount(accountId)
    await openaiAccountService.checkAndApplyUsageLimitStop(accountId, latestAccount)
  }

  const updatedAccount = await openaiAccountService.getAccount(accountId)
  console.log('模拟 OpenAI 账号已更新:\n')
  console.log(`ID: ${updatedAccount.id}`)
  console.log(`名称: ${updatedAccount.name}`)
  console.log(`可调度: ${updatedAccount.schedulable}`)
  console.log(`5小时限额自动停调: ${updatedAccount.autoStopOnFiveHourLimit}`)
  console.log(`周限额自动停调: ${updatedAccount.autoStopOnWeeklyLimit}`)
  console.log(`日均摊自动停调: ${updatedAccount.autoStopOnDailyOveruse}`)
  console.log(`primaryUsedPercent: ${updatedAccount.codexPrimaryUsedPercent || '-'}`)
  console.log(`secondaryUsedPercent: ${updatedAccount.codexSecondaryUsedPercent || '-'}`)
  console.log(`usageLimitAutoStopped: ${updatedAccount.usageLimitAutoStopped || 'false'}`)
  console.log(`usageLimitStopReason: ${updatedAccount.usageLimitStopReason || '-'}`)
  console.log(`usageLimitResumeAt: ${updatedAccount.usageLimitResumeAt || '-'}`)
}

async function deleteMockAccountById(accountId) {
  const account = await openaiAccountService.getAccount(accountId)
  if (!account) {
    throw new Error(`未找到账号: ${accountId}`)
  }

  await openaiAccountService.deleteAccount(accountId)
  console.log(`已删除模拟账号: ${account.name} (${accountId})`)
}

async function deleteMockAccountByName(name) {
  const accounts = await openaiAccountService.getAllAccounts()
  const matchedAccounts = accounts.filter((account) => account.name === name)

  if (matchedAccounts.length === 0) {
    throw new Error(`未找到名称为 ${name} 的账号`)
  }

  for (const account of matchedAccounts) {
    await openaiAccountService.deleteAccount(account.id)
    console.log(`已删除模拟账号: ${account.name} (${account.id})`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.action === 'help') {
    printHelp()
    return
  }

  await redis.connect()

  if (options.action === 'delete') {
    await deleteMockAccountById(options.id)
    return
  }

  if (options.action === 'deleteByName') {
    await deleteMockAccountByName(options.deleteByName)
    return
  }

  if (options.action === 'update') {
    await updateMockAccount(options.id, options)
    return
  }

  await createMockAccount(options)
}

main()
  .catch((error) => {
    console.error('脚本执行失败:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    if (redis.client && redis.isConnected) {
      try {
        await redis.client.quit()
      } catch (error) {
        redis.client.disconnect()
      }
    }

    process.exit(process.exitCode || 0)
  })
