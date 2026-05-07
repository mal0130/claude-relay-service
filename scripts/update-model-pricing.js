#!/usr/bin/env node

/**
 * 手动更新模型价格数据脚本
 * 从价格镜像分支下载最新的模型价格和上下文窗口信息
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')
const pricingSource = require('../config/pricingSource')
const pricingService = require('../src/services/pricingService')

const args = process.argv.slice(2)

function getArgValue(name, defaultValue = null) {
  const equalsArg = args.find((arg) => arg.startsWith(`${name}=`))
  if (equalsArg) {
    return equalsArg.slice(name.length + 1)
  }

  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) {
    return args[index + 1]
  }

  return defaultValue
}

const mirrorMode = args.includes('--mirror')

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  magenta: '\x1b[35m'
}

// 日志函数
const log = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`),
  error: (msg) => console.error(`${colors.red}[ERROR]${colors.reset} ${msg}`),
  warn: (msg) => console.warn(`${colors.yellow}[WARNING]${colors.reset} ${msg}`)
}

// 配置
const config = {
  dataDir: path.join(process.cwd(), 'data'),
  pricingFile: path.join(process.cwd(), 'data', 'model_pricing.json'),
  hashFile: path.join(process.cwd(), 'data', 'model_pricing.sha256'),
  pricingUrl: pricingSource.pricingUrl,
  fallbackFile: path.join(
    process.cwd(),
    'resources',
    'model-pricing',
    'model_prices_and_context_window.json'
  ),
  backupFile: path.join(process.cwd(), 'data', 'model_pricing.backup.json'),
  upstreamPricingUrl:
    process.env.MODEL_PRICING_UPSTREAM_URL ||
    'https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json',
  mirrorOutputDir: path.resolve(
    getArgValue('--output-dir', process.env.PRICE_MIRROR_OUTPUT_DIR || process.cwd())
  ),
  timeout: 30000 // 30秒超时
}

config.mirrorPricingFile = path.join(config.mirrorOutputDir, pricingSource.pricingFileName)
config.mirrorHashFile = path.join(config.mirrorOutputDir, pricingSource.hashFileName)

// 创建数据目录
function ensureDataDir() {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true })
    log.info('Created data directory')
  }
}

// 备份现有文件
function backupExistingFile() {
  if (fs.existsSync(config.pricingFile)) {
    try {
      fs.copyFileSync(config.pricingFile, config.backupFile)
      log.info('Backed up existing pricing file')
      return true
    } catch (error) {
      log.warn(`Failed to backup existing file: ${error.message}`)
      return false
    }
  }
  return false
}

// 恢复备份
function restoreBackup() {
  if (fs.existsSync(config.backupFile)) {
    try {
      fs.copyFileSync(config.backupFile, config.pricingFile)
      log.info('Restored from backup')
      return true
    } catch (error) {
      log.error(`Failed to restore backup: ${error.message}`)
      return false
    }
  }
  return false
}

// 下载价格数据
function downloadPricingData() {
  return new Promise((resolve, reject) => {
    log.info('正在从价格镜像分支拉取最新的模型价格数据...')
    log.info(`拉取地址: ${config.pricingUrl}`)

    const request = https.get(config.pricingUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }

      let data = ''
      let downloadedBytes = 0

      response.on('data', (chunk) => {
        data += chunk
        downloadedBytes += chunk.length
        // 显示下载进度
        process.stdout.write(`\rDownloading... ${Math.round(downloadedBytes / 1024)}KB`)
      })

      response.on('end', async () => {
        process.stdout.write('\n') // 换行
        try {
          const jsonData = JSON.parse(data)

          // 验证数据结构
          if (typeof jsonData !== 'object' || Object.keys(jsonData).length === 0) {
            throw new Error('Invalid pricing data structure')
          }

          const enrichedData = await pricingService.enrichPricingDataWithDeepSeek(jsonData, {
            allowRemote: false
          })

          // 保存到文件
          const formattedJson = JSON.stringify(enrichedData, null, 2)
          fs.writeFileSync(config.pricingFile, formattedJson)

          const hash = crypto.createHash('sha256').update(data).digest('hex')
          fs.writeFileSync(config.hashFile, `${hash}\n`)

          const modelCount = Object.keys(enrichedData).length
          const fileSize = Math.round(fs.statSync(config.pricingFile).size / 1024)

          log.success(`Downloaded pricing data for ${modelCount} models (${fileSize}KB)`)

          // 显示一些统计信息
          const claudeModels = Object.keys(enrichedData).filter((k) => k.includes('claude')).length
          const gptModels = Object.keys(enrichedData).filter((k) => k.includes('gpt')).length
          const geminiModels = Object.keys(enrichedData).filter((k) => k.includes('gemini')).length
          const deepseekModels = Object.keys(enrichedData).filter((k) =>
            k.includes('deepseek')
          ).length

          log.info('Model breakdown:')
          log.info(`  - Claude models: ${claudeModels}`)
          log.info(`  - GPT models: ${gptModels}`)
          log.info(`  - Gemini models: ${geminiModels}`)
          log.info(`  - DeepSeek models: ${deepseekModels}`)
          log.info(
            `  - Other models: ${
              modelCount - claudeModels - gptModels - geminiModels - deepseekModels
            }`
          )

          resolve(enrichedData)
        } catch (error) {
          reject(new Error(`Failed to parse pricing data: ${error.message}`))
        }
      })
    })

    request.on('error', (error) => {
      reject(new Error(`Network error: ${error.message}`))
    })

    request.setTimeout(config.timeout, () => {
      request.destroy()
      reject(new Error(`Download timeout after ${config.timeout / 1000} seconds`))
    })
  })
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }

      const chunks = []
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })

    request.on('error', (error) => {
      reject(new Error(`Network error: ${error.message}`))
    })

    request.setTimeout(config.timeout, () => {
      request.destroy()
      reject(new Error(`Download timeout after ${config.timeout / 1000} seconds`))
    })
  })
}

function mergeExistingDeepSeekEntries(baseData) {
  if (!fs.existsSync(config.mirrorPricingFile)) {
    return baseData
  }

  try {
    const existingData = JSON.parse(fs.readFileSync(config.mirrorPricingFile, 'utf8'))
    const existingDeepSeekEntries = Object.fromEntries(
      Object.entries(existingData).filter(([modelName]) => modelName.includes('deepseek'))
    )
    return { ...existingDeepSeekEntries, ...baseData }
  } catch (error) {
    log.warn(`Failed to load existing DeepSeek mirror entries: ${error.message}`)
    return baseData
  }
}

async function generatePriceMirror() {
  log.info('Generating price mirror data with DeepSeek official pricing...')
  log.info(`Upstream model pricing URL: ${config.upstreamPricingUrl}`)
  log.info(`Mirror output directory: ${config.mirrorOutputDir}`)

  if (!fs.existsSync(config.mirrorOutputDir)) {
    fs.mkdirSync(config.mirrorOutputDir, { recursive: true })
  }

  const rawData = await downloadText(config.upstreamPricingUrl)
  const upstreamData = JSON.parse(rawData)
  if (typeof upstreamData !== 'object' || Object.keys(upstreamData).length === 0) {
    throw new Error('Invalid upstream pricing data structure')
  }

  const dataWithExistingDeepSeek = mergeExistingDeepSeekEntries(upstreamData)
  const enrichedData = await pricingService.enrichPricingDataWithDeepSeek(
    dataWithExistingDeepSeek,
    {
      allowRemote: true
    }
  )
  const formattedJson = JSON.stringify(enrichedData, null, 2)
  const hash = crypto.createHash('sha256').update(formattedJson).digest('hex')

  fs.writeFileSync(config.mirrorPricingFile, formattedJson)
  fs.writeFileSync(config.mirrorHashFile, `${hash}\n`)

  const modelCount = Object.keys(enrichedData).length
  const deepseekModels = Object.keys(enrichedData).filter((modelName) =>
    modelName.includes('deepseek')
  ).length
  log.success(`Generated price mirror for ${modelCount} models`)
  log.info(`DeepSeek models: ${deepseekModels}`)
  log.info(`Hash: ${hash}`)
}

// 使用 fallback 文件
async function useFallback() {
  log.warn('Attempting to use fallback pricing data...')

  if (!fs.existsSync(config.fallbackFile)) {
    log.error(`Fallback file not found: ${config.fallbackFile}`)
    return false
  }

  try {
    const fallbackData = fs.readFileSync(config.fallbackFile, 'utf8')
    const jsonData = await pricingService.enrichPricingDataWithDeepSeek(JSON.parse(fallbackData), {
      allowRemote: false,
      forceBuiltIn: true
    })

    // 保存到data目录
    const formattedJson = JSON.stringify(jsonData, null, 2)
    fs.writeFileSync(config.pricingFile, formattedJson)
    const hash = crypto.createHash('sha256').update(formattedJson).digest('hex')
    fs.writeFileSync(config.hashFile, `${hash}\n`)

    const modelCount = Object.keys(jsonData).length
    log.warn(`Using fallback pricing data for ${modelCount} models`)
    log.info('Note: Fallback data may be outdated. Try updating again later.')

    return true
  } catch (error) {
    log.error(`Failed to use fallback: ${error.message}`)
    return false
  }
}

// 显示当前状态
function showCurrentStatus() {
  if (fs.existsSync(config.pricingFile)) {
    const stats = fs.statSync(config.pricingFile)
    const fileAge = Date.now() - stats.mtime.getTime()
    const ageInHours = Math.round(fileAge / (60 * 60 * 1000))
    const ageInDays = Math.floor(ageInHours / 24)

    let ageString = ''
    if (ageInDays > 0) {
      ageString = `${ageInDays} day${ageInDays > 1 ? 's' : ''} and ${ageInHours % 24} hour${ageInHours % 24 !== 1 ? 's' : ''}`
    } else {
      ageString = `${ageInHours} hour${ageInHours !== 1 ? 's' : ''}`
    }

    log.info(`Current pricing file age: ${ageString}`)

    try {
      const data = JSON.parse(fs.readFileSync(config.pricingFile, 'utf8'))
      log.info(`Current file contains ${Object.keys(data).length} models`)
    } catch (error) {
      log.warn('Current file exists but could not be parsed')
    }
  } else {
    log.info('No existing pricing file found')
  }
}

// 主函数
async function main() {
  console.log(`${colors.bright}${colors.blue}======================================${colors.reset}`)
  console.log(`${colors.bright}  Model Pricing Update Tool${colors.reset}`)
  console.log(
    `${colors.bright}${colors.blue}======================================${colors.reset}\n`
  )

  if (mirrorMode) {
    await generatePriceMirror()
    console.log(`\n${colors.green}✅ Price mirror generated successfully!${colors.reset}`)
    process.exit(0)
  }

  // 显示当前状态
  showCurrentStatus()
  console.log('')

  // 确保数据目录存在
  ensureDataDir()

  // 备份现有文件
  const hasBackup = backupExistingFile()

  try {
    // 尝试下载最新数据
    await downloadPricingData()

    // 清理备份文件（成功下载后）
    if (hasBackup && fs.existsSync(config.backupFile)) {
      fs.unlinkSync(config.backupFile)
      log.info('Cleaned up backup file')
    }

    console.log(`\n${colors.green}✅ Model pricing updated successfully!${colors.reset}`)
    process.exit(0)
  } catch (error) {
    log.error(`Download failed: ${error.message}`)

    // 尝试恢复备份
    if (hasBackup) {
      if (restoreBackup()) {
        log.info('Original file restored')
      }
    }

    // 尝试使用 fallback
    if (await useFallback()) {
      console.log(
        `\n${colors.yellow}⚠️  Using fallback data (update completed with warnings)${colors.reset}`
      )
      process.exit(0)
    } else {
      console.log(`\n${colors.red}❌ Failed to update model pricing${colors.reset}`)
      process.exit(1)
    }
  }
}

// 处理未捕获的错误
process.on('unhandledRejection', (error) => {
  log.error(`Unhandled error: ${error.message}`)
  process.exit(1)
})

// 运行主函数
main().catch((error) => {
  log.error(`Fatal error: ${error.message}`)
  process.exit(1)
})
