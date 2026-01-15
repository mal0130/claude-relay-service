const ldap = require('ldapjs')
const logger = require('../utils/logger')
const config = require('../../config/config')
const userService = require('./userService')

class LdapService {
  constructor() {
    this.config = config.ldap || {}
    this.client = null

    // 验证配置 - 只有在 LDAP 配置存在且启用时才验证
    if (this.config && this.config.enabled) {
      this.validateConfiguration()
    }
  }

  // 🔍 验证LDAP配置
  validateConfiguration() {
    const errors = []

    if (!this.config.server) {
      errors.push('LDAP server configuration is missing')
    } else {
      if (!this.config.server.url || typeof this.config.server.url !== 'string') {
        errors.push('LDAP server URL is not configured or invalid')
      }

      // 验证绑定配置：必须配置 bindDN/bindCredentials (管理员模式) 或 bindDNPattern (直接绑定模式)
      const hasAdminBind =
        this.config.server.bindDN &&
        typeof this.config.server.bindDN === 'string' &&
        this.config.server.bindCredentials &&
        typeof this.config.server.bindCredentials === 'string'

      const hasDirectBind =
        this.config.server.bindDNPattern && typeof this.config.server.bindDNPattern === 'string'

      if (!hasAdminBind && !hasDirectBind) {
        errors.push(
          'LDAP configuration error: Either (bindDN & bindCredentials) OR bindDNPattern must be configured'
        )
      }

      if (!this.config.server.searchBase || typeof this.config.server.searchBase !== 'string') {
        errors.push('LDAP search base is not configured or invalid')
      }

      if (!this.config.server.searchFilter || typeof this.config.server.searchFilter !== 'string') {
        errors.push('LDAP search filter is not configured or invalid')
      }
    }

    if (errors.length > 0) {
      logger.error('❌ LDAP configuration validation failed:', errors)
      // Don't throw error during initialization, just log warnings
      logger.warn('⚠️ LDAP authentication may not work properly due to configuration errors')
    } else {
      logger.info('✅ LDAP configuration validation passed')
    }
  }

  // 🔍 提取LDAP条目的DN
  extractDN(ldapEntry) {
    if (!ldapEntry) {
      return null
    }

    // Try different ways to get the DN
    let dn = null

    // Method 1: Direct dn property
    if (ldapEntry.dn) {
      ;({ dn } = ldapEntry)
    }
    // Method 2: objectName property (common in some LDAP implementations)
    else if (ldapEntry.objectName) {
      dn = ldapEntry.objectName
    }
    // Method 3: distinguishedName property
    else if (ldapEntry.distinguishedName) {
      dn = ldapEntry.distinguishedName
    }
    // Method 4: Check if the entry itself is a DN string
    else if (typeof ldapEntry === 'string' && ldapEntry.includes('=')) {
      dn = ldapEntry
    }

    // Convert DN to string if it's an object
    if (dn && typeof dn === 'object') {
      if (dn.toString && typeof dn.toString === 'function') {
        dn = dn.toString()
      } else if (dn.dn && typeof dn.dn === 'string') {
        ;({ dn } = dn)
      }
    }

    // Validate the DN format
    if (typeof dn === 'string' && dn.trim() !== '' && dn.includes('=')) {
      return dn.trim()
    }

    return null
  }

  // 🌐 从DN中提取域名，用于Windows AD UPN格式认证
  extractDomainFromDN(dnString) {
    try {
      if (!dnString || typeof dnString !== 'string') {
        return null
      }

      // 提取所有DC组件：DC=test,DC=demo,DC=com
      const dcMatches = dnString.match(/DC=([^,]+)/gi)
      if (!dcMatches || dcMatches.length === 0) {
        return null
      }

      // 提取DC值并连接成域名
      const domainParts = dcMatches.map((match) => {
        const value = match.replace(/DC=/i, '').trim()
        return value
      })

      if (domainParts.length > 0) {
        const domain = domainParts.join('.')
        logger.debug(`🌐 从DN提取域名: ${domain}`)
        return domain
      }

      return null
    } catch (error) {
      logger.debug('⚠️ 域名提取失败:', error.message)
      return null
    }
  }

  // 🔗 创建LDAP客户端连接
  createClient(options = {}) {
    try {
      const clientOptions = {
        url: this.config.server.url,
        timeout: this.config.server.timeout,
        connectTimeout: this.config.server.connectTimeout,
        reconnect: false, // 默认为 false，避免在 API 请求中无限重连
        ...options // 允许覆盖默认选项
      }

      // 如果使用 LDAPS (SSL/TLS)，添加 TLS 选项
      if (this.config.server.url.toLowerCase().startsWith('ldaps://')) {
        const tlsOptions = {}

        // 证书验证设置
        if (this.config.server.tls) {
          if (typeof this.config.server.tls.rejectUnauthorized === 'boolean') {
            tlsOptions.rejectUnauthorized = this.config.server.tls.rejectUnauthorized
          }

          // CA 证书
          if (this.config.server.tls.ca) {
            tlsOptions.ca = this.config.server.tls.ca
          }

          // 客户端证书和私钥 (双向认证)
          if (this.config.server.tls.cert) {
            tlsOptions.cert = this.config.server.tls.cert
          }

          if (this.config.server.tls.key) {
            tlsOptions.key = this.config.server.tls.key
          }

          // 服务器名称 (SNI)
          if (this.config.server.tls.servername) {
            tlsOptions.servername = this.config.server.tls.servername
          }
        }

        clientOptions.tlsOptions = tlsOptions

        logger.debug('🔒 Creating LDAPS client with TLS options:', {
          url: this.config.server.url,
          rejectUnauthorized: tlsOptions.rejectUnauthorized,
          hasCA: !!tlsOptions.ca,
          hasCert: !!tlsOptions.cert,
          hasKey: !!tlsOptions.key,
          servername: tlsOptions.servername
        })
      }

      const client = ldap.createClient(clientOptions)

      // 设置错误处理
      client.on('error', (err) => {
        if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
          logger.error('🔒 LDAP TLS certificate error:', {
            code: err.code,
            message: err.message,
            hint: 'Consider setting LDAP_TLS_REJECT_UNAUTHORIZED=false for self-signed certificates'
          })
        } else {
          logger.error('🔌 LDAP client error:', err)
        }
      })

      client.on('connect', () => {
        if (this.config.server.url.toLowerCase().startsWith('ldaps://')) {
          logger.info('🔒 LDAPS client connected successfully')
        } else {
          logger.info('🔗 LDAP client connected successfully')
        }
      })

      client.on('connectTimeout', () => {
        logger.warn('⏱️ LDAP connection timeout')
      })

      return client
    } catch (error) {
      logger.error('❌ Failed to create LDAP client:', error)
      throw error
    }
  }

  // 🔒 绑定LDAP连接（管理员认证）
  async bindClient(client) {
    return new Promise((resolve, reject) => {
      // 验证绑定凭据
      const { bindDN } = this.config.server
      const { bindCredentials } = this.config.server

      if (!bindDN || typeof bindDN !== 'string') {
        const error = new Error('LDAP bind DN is not configured or invalid')
        logger.error('❌ LDAP configuration error:', error.message)
        reject(error)
        return
      }

      if (!bindCredentials || typeof bindCredentials !== 'string') {
        const error = new Error('LDAP bind credentials are not configured or invalid')
        logger.error('❌ LDAP configuration error:', error.message)
        reject(error)
        return
      }

      client.bind(bindDN, bindCredentials, (err) => {
        if (err) {
          logger.error('❌ LDAP bind failed:', err)
          reject(err)
        } else {
          logger.debug('🔑 LDAP bind successful')
          resolve()
        }
      })
    })
  }

  // 🔍 搜索用户
  async searchUser(client, username) {
    return new Promise((resolve, reject) => {
      // 防止LDAP注入：转义特殊字符
      // 根据RFC 4515，需要转义的特殊字符：* ( ) \ NUL
      const escapedUsername = username
        .replace(/\\/g, '\\5c') // 反斜杠必须先转义
        .replace(/\*/g, '\\2a') // 星号
        .replace(/\(/g, '\\28') // 左括号
        .replace(/\)/g, '\\29') // 右括号
        .replace(/\0/g, '\\00') // NUL字符
        .replace(/\//g, '\\2f') // 斜杠

      const searchFilter = this.config.server.searchFilter.replace('{{username}}', escapedUsername)
      const searchOptions = {
        scope: 'sub',
        filter: searchFilter,
        attributes: this.config.server.searchAttributes
      }

      logger.debug(`🔍 Searching for user: ${username} with filter: ${searchFilter}`)

      const entries = []

      client.search(this.config.server.searchBase, searchOptions, (err, res) => {
        if (err) {
          logger.error('❌ LDAP search error:', err)
          reject(err)
          return
        }

        res.on('searchEntry', (entry) => {
          logger.debug('🔍 LDAP search entry received:', {
            dn: entry.dn,
            objectName: entry.objectName,
            type: typeof entry.dn,
            entryType: typeof entry,
            hasAttributes: !!entry.attributes,
            attributeCount: entry.attributes ? entry.attributes.length : 0
          })
          entries.push(entry)
        })

        res.on('searchReference', (referral) => {
          logger.debug('🔗 LDAP search referral:', referral.uris)
        })

        res.on('error', (error) => {
          logger.error('❌ LDAP search result error:', error)
          reject(error)
        })

        res.on('end', (result) => {
          logger.debug(
            `✅ LDAP search completed. Status: ${result.status}, Found ${entries.length} entries`
          )

          if (entries.length === 0) {
            resolve(null)
          } else {
            // Log the structure of the first entry for debugging
            if (entries[0]) {
              logger.debug('🔍 Full LDAP entry structure:', {
                entryType: typeof entries[0],
                entryConstructor: entries[0].constructor?.name,
                entryKeys: Object.keys(entries[0]),
                entryStringified: JSON.stringify(entries[0], null, 2).substring(0, 500)
              })
            }

            if (entries.length === 1) {
              resolve(entries[0])
            } else {
              logger.warn(`⚠️ Multiple LDAP entries found for username: ${username}`)
              resolve(entries[0]) // 使用第一个结果
            }
          }
        })
      })
    })
  }

  // 🔐 验证用户密码
  async authenticateUser(userDN, password) {
    return new Promise((resolve, reject) => {
      // 验证输入参数
      if (!userDN || typeof userDN !== 'string') {
        const error = new Error('User DN is not provided or invalid')
        logger.error('❌ LDAP authentication error:', error.message)
        reject(error)
        return
      }

      if (!password || typeof password !== 'string') {
        logger.debug(`🚫 Invalid or empty password for DN: ${userDN}`)
        resolve(false)
        return
      }

      const authClient = this.createClient()

      authClient.bind(userDN, password, (err) => {
        authClient.unbind() // 立即关闭认证客户端

        if (err) {
          if (err.name === 'InvalidCredentialsError') {
            logger.debug(`🚫 Invalid credentials for DN: ${userDN}`)
            resolve(false)
          } else {
            logger.error('❌ LDAP authentication error:', err)
            reject(err)
          }
        } else {
          logger.debug(`✅ Authentication successful for DN: ${userDN}`)
          resolve(true)
        }
      })
    })
  }

  // 🔐 Windows AD兼容认证 - 在DN认证失败时尝试多种格式
  async tryWindowsADAuthentication(username, password) {
    if (!username || !password) {
      return false
    }

    // 从searchBase提取域名
    const domain = this.extractDomainFromDN(this.config.server.searchBase)

    const adFormats = []

    if (domain) {
      // UPN格式（Windows AD标准）
      adFormats.push(`${username}@${domain}`)

      // 如果域名有多个部分，也尝试简化版本
      const domainParts = domain.split('.')
      if (domainParts.length > 1) {
        adFormats.push(`${username}@${domainParts.slice(-2).join('.')}`) // 只取后两部分
      }

      // 域\用户名格式
      const firstDomainPart = domainParts[0]
      if (firstDomainPart) {
        adFormats.push(`${firstDomainPart}\\${username}`)
        adFormats.push(`${firstDomainPart.toUpperCase()}\\${username}`)
      }
    }

    // 纯用户名（最后尝试）
    adFormats.push(username)

    logger.info(`🔄 尝试 ${adFormats.length} 种Windows AD认证格式...`)

    for (const format of adFormats) {
      try {
        logger.info(`🔍 尝试格式: ${format}`)
        const result = await this.tryDirectBind(format, password)
        if (result) {
          logger.info(`✅ Windows AD认证成功: ${format}`)
          return true
        }
        logger.debug(`❌ 认证失败: ${format}`)
      } catch (error) {
        logger.debug(`认证异常 ${format}:`, error.message)
      }
    }

    logger.info(`🚫 所有Windows AD格式认证都失败了`)
    return false
  }

  // 🔐 直接尝试绑定认证的辅助方法
  async tryDirectBind(identifier, password) {
    return new Promise((resolve, reject) => {
      const authClient = this.createClient()

      authClient.bind(identifier, password, (err) => {
        authClient.unbind()

        if (err) {
          if (err.name === 'InvalidCredentialsError') {
            resolve(false)
          } else {
            reject(err)
          }
        } else {
          resolve(true)
        }
      })
    })
  }

  // 📝 提取用户信息
  extractUserInfo(ldapEntry, username) {
    try {
      const attributes = ldapEntry.attributes || []
      const userInfo = { username }

      // 创建属性映射 (转换所有键为小写以进行不区分大小写的匹配)
      const attrMap = {}
      attributes.forEach((attr) => {
        const name = (attr.type || attr.name).toLowerCase()
        const values = Array.isArray(attr.values) ? attr.values : [attr.values]
        // 有些 LDAP 实现可能返回 Buffer，尝试转换为字符串
        const processedValues = values.map((val) => {
          if (Buffer.isBuffer(val)) {
            return val.toString('utf8')
          }
          return val
        })

        attrMap[name] = processedValues.length === 1 ? processedValues[0] : processedValues
      })

      // Log available attributes for debugging
      // 临时开启 INFO 级别日志以调试属性获取问题
      logger.info('📋 LDAP Attributes extracted:', {
        keys: Object.keys(attrMap),
        sn: attrMap['sn'],
        cn: attrMap['cn'],
        uid: attrMap['uid'],
        mail: attrMap['mail']
      })

      // 根据配置映射用户属性 (配置的键也转换为小写)
      const mapping = this.config.userMapping
      const getMappedValue = (configKey) => {
        if (!configKey) {
          return undefined
        }
        const val = attrMap[configKey.toLowerCase()]
        // 处理空数组或空值
        if (Array.isArray(val) && val.length === 0) {
          return undefined
        }
        if (val === '') {
          return undefined
        }
        return val
      }

      // 特殊处理：如果配置了 username 映射，且能获取到对应属性值，则覆盖默认的登录用户名
      // 这允许用户用 'maliang' 登录，但系统账号关联到 '马亮' (如果 sn=马亮)
      const mappedUsername = getMappedValue(mapping.username)
      if (mappedUsername && typeof mappedUsername === 'string' && mappedUsername.trim() !== '') {
        const oldUsername = userInfo.username
        userInfo.username = mappedUsername.trim()
        logger.info(
          `🔄 User identity mapped: ${oldUsername} -> ${userInfo.username} (via ${mapping.username})`
        )
      }

      userInfo.displayName = getMappedValue(mapping.displayName) || userInfo.username // Fallback to mapped username
      userInfo.email = getMappedValue(mapping.email) || ''
      userInfo.firstName = getMappedValue(mapping.firstName) || ''
      userInfo.lastName = getMappedValue(mapping.lastName) || ''

      // 如果没有displayName，尝试组合firstName和lastName
      if (!userInfo.displayName || userInfo.displayName === username) {
        if (userInfo.firstName || userInfo.lastName) {
          userInfo.displayName = `${userInfo.firstName || ''} ${userInfo.lastName || ''}`.trim()
        }
      }

      logger.debug('📋 Extracted user info:', {
        username: userInfo.username,
        displayName: userInfo.displayName,
        email: userInfo.email
      })

      return userInfo
    } catch (error) {
      logger.error('❌ Error extracting user info:', error)
      return { username }
    }
  }

  // 🔍 验证和清理用户名
  validateAndSanitizeUsername(username) {
    if (!username || typeof username !== 'string' || username.trim() === '') {
      throw new Error('Username is required and must be a non-empty string')
    }

    const trimmedUsername = username.trim()

    // 用户名只能包含字母、数字、下划线和连字符
    const usernameRegex = /^[a-zA-Z0-9_-]+$/
    if (!usernameRegex.test(trimmedUsername)) {
      throw new Error('Username can only contain letters, numbers, underscores, and hyphens')
    }

    // 长度限制 (防止过长的输入)
    if (trimmedUsername.length > 64) {
      throw new Error('Username cannot exceed 64 characters')
    }

    // 不能以连字符开头或结尾
    if (trimmedUsername.startsWith('-') || trimmedUsername.endsWith('-')) {
      throw new Error('Username cannot start or end with a hyphen')
    }

    return trimmedUsername
  }

  // 🔐 主要的登录验证方法
  async authenticateUserCredentials(username, password) {
    if (!this.config.enabled) {
      throw new Error('LDAP authentication is not enabled')
    }

    // 验证和清理用户名 (防止LDAP注入)
    const sanitizedUsername = this.validateAndSanitizeUsername(username)

    if (!password || typeof password !== 'string' || password.trim() === '') {
      throw new Error('Password is required and must be a non-empty string')
    }

    // 验证LDAP服务器配置
    if (!this.config.server || !this.config.server.url) {
      throw new Error('LDAP server URL is not configured')
    }

    const hasAdminBind = this.config.server.bindDN && this.config.server.bindCredentials
    const hasDirectBind = this.config.server.bindDNPattern

    if (!hasAdminBind && !hasDirectBind) {
      throw new Error(
        'LDAP configuration error: Either (bindDN & bindCredentials) OR bindDNPattern must be configured'
      )
    }

    if (!this.config.server.searchBase || typeof this.config.server.searchBase !== 'string') {
      throw new Error('LDAP search base is not configured')
    }

    let mainClient = null // 用于在最后阶段获取用户信息的 client

    try {
      let ldapEntry = null
      let userDN = null

      // 1. 获取用户 DN
      // 优先使用直接绑定模式 (bindDNPattern)，因为它通常是用户显式配置的特定认证方式
      if (hasDirectBind) {
        // 模式 B: 直接使用模式构建 DN (无需管理员权限)
        userDN = this.config.server.bindDNPattern.replace(/{{username}}/g, sanitizedUsername)
        logger.debug(`🔧 Constructed user DN from pattern: ${userDN}`)
      } else if (hasAdminBind) {
        // 模式 A: 管理员绑定 -> 搜索用户 -> 获取 DN
        mainClient = this.createClient()
        await this.bindClient(mainClient)
        ldapEntry = await this.searchUser(mainClient, sanitizedUsername)

        if (!ldapEntry) {
          logger.info(`🚫 User not found in LDAP: ${sanitizedUsername}`)
          if (mainClient) {
            mainClient.unbind(() => {})
          }
          return { success: false, message: 'Invalid username or password' }
        }

        userDN = this.extractDN(ldapEntry)
      }

      // 2. 验证用户 DN
      if (!userDN) {
        logger.error(`❌ Invalid or missing DN for user: ${sanitizedUsername}`)
        return { success: false, message: 'Authentication service error' }
      }

      // 3. 验证用户密码
      let isPasswordValid = false

      // 尝试使用提取的/构建的 DN 进行绑定认证
      try {
        isPasswordValid = await this.authenticateUser(userDN, password)
        if (isPasswordValid) {
          logger.info(`✅ DN authentication successful for user: ${sanitizedUsername}`)
        }
      } catch (error) {
        logger.debug(
          `DN authentication failed for user: ${sanitizedUsername}, error: ${error.message}`
        )
      }

      // 如果 DN 认证失败，尝试 Windows AD 多格式认证 (仅在配置了 admin bind 时，或者明确需要 fallback 时)
      // 注意：如果��直接绑定模式，通常 DN 模式就是准确的，但也可以尝试 AD 格式
      if (!isPasswordValid) {
        logger.debug(`🔄 Trying Windows AD authentication formats for user: ${sanitizedUsername}`)
        isPasswordValid = await this.tryWindowsADAuthentication(sanitizedUsername, password)
        if (isPasswordValid) {
          logger.info(`✅ Windows AD authentication successful for user: ${sanitizedUsername}`)
        }
      }

      if (!isPasswordValid) {
        logger.info(`🚫 All authentication methods failed for user: ${sanitizedUsername}`)
        return { success: false, message: 'Invalid username or password' }
      }

      // 4. 获取用户信息 (如果还没有)
      // 如果是直接绑定模式，我们还没有搜索用户信息，现在需要用用户的凭据去搜索
      if (!ldapEntry) {
        try {
          // Initialize mainClient if not already initialized
          if (!mainClient) {
            mainClient = this.createClient()
          }

          // 使用用户凭据绑定主客户端
          await new Promise((resolve, reject) => {
            mainClient.bind(userDN, password, (err) => {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })

          // 搜索用户信息
          ldapEntry = await this.searchUser(mainClient, sanitizedUsername)

          if (!ldapEntry) {
            // 登录成功但搜不到用户详情，创建一个基本对象
            logger.warn(`⚠️ User authenticated but attributes not found: ${sanitizedUsername}`)
            ldapEntry = { dn: userDN, attributes: [] }
          }
        } catch (error) {
          logger.error(`❌ Failed to fetch user info after login: ${error.message}`)
          // 降级处理：仅使用用户名
          ldapEntry = { dn: userDN, attributes: [] }
        }
      }

      // 5. 提取用户信息
      const userInfo = this.extractUserInfo(ldapEntry, sanitizedUsername)

      // 6. 创建或更新本地用户
      const user = await userService.createOrUpdateUser(userInfo)

      // 7. 检查用户是否被禁用
      if (!user.isActive) {
        logger.security(
          `🔒 Disabled user LDAP login attempt: ${sanitizedUsername} from LDAP authentication`
        )
        return {
          success: false,
          message: 'Your account has been disabled. Please contact administrator.'
        }
      }

      // 8. 记录登录
      await userService.recordUserLogin(user.id)

      // 9. 创建用户会话
      const sessionToken = await userService.createUserSession(user.id)

      logger.info(`✅ LDAP authentication successful for user: ${sanitizedUsername}`)

      return {
        success: true,
        user,
        sessionToken,
        message: 'Authentication successful'
      }
    } catch (error) {
      // 记录详细错误供调试，但不向用户暴露
      logger.error('❌ LDAP authentication error:', {
        username: sanitizedUsername,
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })

      // 返回通用错误消息，避免信息泄露
      // 不要尝试解析具体的错误信息，因为不同LDAP服务器返回的格式不同
      return {
        success: false,
        message: 'Authentication service unavailable'
      }
    } finally {
      // 确保客户端连接被关闭
      if (mainClient) {
        mainClient.unbind((err) => {
          if (err) {
            logger.debug('Error unbinding LDAP client:', err)
          }
        })
      }
    }
  }

  // 🔍 测试LDAP连接
  async testConnection() {
    if (!this.config.enabled) {
      return { success: false, message: 'LDAP is not enabled' }
    }

    const client = this.createClient()

    try {
      await this.bindClient(client)

      return {
        success: true,
        message: 'LDAP connection successful',
        server: this.config.server.url,
        searchBase: this.config.server.searchBase
      }
    } catch (error) {
      logger.error('❌ LDAP connection test failed:', {
        error: error.message,
        server: this.config.server.url,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })

      // 提供通用错误消息，避免泄露系统细节
      let userMessage = 'LDAP connection failed'

      // 对于某些已知错误类型，提供有用但不泄露细节的信息
      if (error.code === 'ECONNREFUSED') {
        userMessage = 'Unable to connect to LDAP server'
      } else if (error.code === 'ETIMEDOUT') {
        userMessage = 'LDAP server connection timeout'
      } else if (error.name === 'InvalidCredentialsError') {
        userMessage = 'LDAP bind credentials are invalid'
      }

      return {
        success: false,
        message: userMessage,
        server: this.config.server.url.replace(/:[^:]*@/, ':***@') // 隐藏密码部分
      }
    } finally {
      if (client) {
        client.unbind((err) => {
          if (err) {
            logger.debug('Error unbinding test LDAP client:', err)
          }
        })
      }
    }
  }

  // 📊 获取LDAP配置信息（不包含敏感信息）
  getConfigInfo() {
    const configInfo = {
      enabled: this.config.enabled,
      server: {
        url: this.config.server.url,
        searchBase: this.config.server.searchBase,
        searchFilter: this.config.server.searchFilter,
        timeout: this.config.server.timeout,
        connectTimeout: this.config.server.connectTimeout
      },
      userMapping: this.config.userMapping
    }

    // 添加 TLS 配置信息（不包含敏感数据）
    if (this.config.server.url.toLowerCase().startsWith('ldaps://') && this.config.server.tls) {
      configInfo.server.tls = {
        rejectUnauthorized: this.config.server.tls.rejectUnauthorized,
        hasCA: !!this.config.server.tls.ca,
        hasCert: !!this.config.server.tls.cert,
        hasKey: !!this.config.server.tls.key,
        servername: this.config.server.tls.servername
      }
    }

    return configInfo
  }
}

module.exports = new LdapService()
