<template>
  <div class="space-y-6">
    <div class="sm:flex sm:items-center">
      <div class="sm:flex-auto">
        <h1 class="text-2xl font-semibold text-gray-900 dark:text-gray-100">使用统计</h1>
        <p class="mt-2 text-sm text-gray-700 dark:text-gray-300">查看您的 API 使用统计和成本</p>
      </div>
      <div class="mt-4 sm:ml-16 sm:mt-0 sm:flex-none">
        <select
          v-model="selectedPeriod"
          class="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 sm:text-sm"
          @change="loadUsageStats"
        >
          <option value="day">最近 24 小时</option>
          <option value="week">最近 7 天</option>
          <option value="month">最近 30 天</option>
          <option value="quarter">最近 90 天</option>
        </select>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="py-12 text-center">
      <svg
        class="mx-auto h-8 w-8 animate-spin text-blue-600"
        fill="none"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle
          class="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          stroke-width="4"
        ></circle>
        <path
          class="opacity-75"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          fill="currentColor"
        ></path>
      </svg>
      <p class="mt-2 text-sm text-gray-500">正在加载使用统计...</p>
    </div>

    <!-- Stats Cards -->
    <div v-else class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
      <div class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="p-5">
          <div class="flex items-center">
            <div class="flex-shrink-0">
              <svg
                class="h-6 w-6 text-blue-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                />
              </svg>
            </div>
            <div class="ml-5 w-0 flex-1">
              <dl>
                <dt class="truncate text-sm font-medium text-gray-500 dark:text-gray-400">
                  总请求数
                </dt>
                <dd class="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {{ formatNumber(usageStats?.totalRequests || 0) }}
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </div>

      <div class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="p-5">
          <div class="flex items-center">
            <div class="flex-shrink-0">
              <svg
                class="h-6 w-6 text-green-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                />
              </svg>
            </div>
            <div class="ml-5 w-0 flex-1">
              <dl>
                <dt class="truncate text-sm font-medium text-gray-500 dark:text-gray-400">
                  输入 Tokens
                </dt>
                <dd class="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {{ formatNumber(usageStats?.totalInputTokens || 0) }}
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </div>

      <div class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="p-5">
          <div class="flex items-center">
            <div class="flex-shrink-0">
              <svg
                class="h-6 w-6 text-purple-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                />
              </svg>
            </div>
            <div class="ml-5 w-0 flex-1">
              <dl>
                <dt class="truncate text-sm font-medium text-gray-500 dark:text-gray-400">
                  输出 Tokens
                </dt>
                <dd class="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {{ formatNumber(usageStats?.totalOutputTokens || 0) }}
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </div>

      <div class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="p-5">
          <div class="flex items-center">
            <div class="flex-shrink-0">
              <svg
                class="h-6 w-6 text-yellow-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                />
              </svg>
            </div>
            <div class="ml-5 w-0 flex-1">
              <dl>
                <dt class="truncate text-sm font-medium text-gray-500 dark:text-gray-400">
                  总成本
                </dt>
                <dd class="text-lg font-medium text-gray-900 dark:text-gray-100">
                  ${{ (usageStats?.totalCost || 0).toFixed(4) }}
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Model Usage Charts -->
    <div
      v-if="!loading && usageStats && usageStats.modelStats?.length > 0"
      class="grid grid-cols-1 gap-6 lg:grid-cols-2"
    >
      <!-- Model Usage Pie Chart -->
      <div class="rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="px-4 py-5 sm:p-6">
          <h3 class="mb-4 text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            Token 使用分布
          </h3>
          <div class="relative" style="height: 300px">
            <canvas ref="modelUsageChart" />
          </div>
        </div>
      </div>

      <!-- Model Stats Table -->
      <div class="rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="px-4 py-5 sm:p-6">
          <h3 class="mb-4 text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            模型使用详情
          </h3>
          <div class="max-h-[300px] space-y-3 overflow-auto">
            <div
              v-for="model in usageStats.modelStats"
              :key="model.name"
              class="flex items-center justify-between rounded-lg border border-gray-200 p-3 dark:border-gray-700"
            >
              <div class="flex items-center">
                <div class="flex-shrink-0">
                  <div
                    class="h-3 w-3 rounded-full"
                    :style="{ backgroundColor: getModelColor(model.name) }"
                  ></div>
                </div>
                <div class="ml-3">
                  <p class="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {{ model.name }}
                  </p>
                  <p class="text-xs text-gray-500 dark:text-gray-400">
                    {{ calculatePercentage(model) }}%
                  </p>
                </div>
              </div>
              <div class="text-right">
                <p class="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {{ formatNumber(model.requests) }} 请求
                </p>
                <p class="text-xs text-gray-500 dark:text-gray-400">${{ model.cost.toFixed(4) }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Usage Trend Chart -->
    <div
      v-if="!loading && usageStats && usageStats.dailyStats?.length > 0"
      class="rounded-lg bg-white shadow dark:bg-gray-800"
    >
      <div class="px-4 py-5 sm:p-6">
        <h3 class="mb-4 text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
          使用趋势
        </h3>
        <div class="relative" style="height: 350px">
          <canvas ref="usageTrendChart" />
        </div>
      </div>
    </div>

    <!-- Usage Details Table -->
    <div
      v-if="!loading && usageDetails.length > 0"
      class="rounded-lg bg-white shadow dark:bg-gray-800"
    >
      <div class="px-4 py-5 sm:p-6">
        <h3 class="mb-4 text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
          使用明细
        </h3>
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-700">
              <tr>
                <th
                  class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  日期
                </th>
                <th
                  class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  请求数
                </th>
                <th
                  class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  输入 Tokens
                </th>
                <th
                  class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  输出 Tokens
                </th>
                <th
                  class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  Token 总量
                </th>
                <th
                  class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  scope="col"
                >
                  成本
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              <tr
                v-for="detail in usageDetails"
                :key="detail.date"
                class="hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <td
                  class="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900 dark:text-gray-100"
                >
                  {{ detail.date }}
                </td>
                <td class="whitespace-nowrap px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                  {{ formatNumber(detail.requests || 0) }}
                </td>
                <td class="whitespace-nowrap px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                  {{ formatNumber(detail.inputTokens || 0) }}
                </td>
                <td class="whitespace-nowrap px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                  {{ formatNumber(detail.outputTokens || 0) }}
                </td>
                <td class="whitespace-nowrap px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                  {{ formatNumber((detail.inputTokens || 0) + (detail.outputTokens || 0)) }}
                </td>
                <td
                  class="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900 dark:text-gray-100"
                >
                  ${{ (detail.cost || 0).toFixed(4) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- No Data State -->
    <div
      v-if="!loading && (!usageStats || usageStats.totalRequests === 0)"
      class="rounded-lg bg-white py-12 text-center shadow dark:bg-gray-800"
    >
      <svg
        class="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
        />
      </svg>
      <h3 class="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">无使用数据</h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        您还没有发起任何 API 请求。创建 API 密钥并开始使用服务以查看使用统计。
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import Chart from 'chart.js/auto'
import { useUserStore } from '@/stores/user'
import { useThemeStore } from '@/stores/theme'
import { showToast, formatNumber } from '@/utils/tools'

const userStore = useUserStore()
const themeStore = useThemeStore()
const { isDarkMode } = storeToRefs(themeStore)

const loading = ref(true)
const selectedPeriod = ref('week')
const usageStats = ref(null)

// Chart refs and instances
const modelUsageChart = ref(null)
const usageTrendChart = ref(null)
let modelUsageChartInstance = null
let usageTrendChartInstance = null

// Chart colors (matching DashboardView.vue)
const modelColors = [
  '#3B82F6',
  '#10B981',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#EC4899',
  '#14B8A6',
  '#F97316',
  '#6366F1',
  '#84CC16'
]

// Chart colors configuration (based on theme)
const chartColors = computed(() => ({
  text: isDarkMode.value ? '#e5e7eb' : '#374151',
  grid: isDarkMode.value ? 'rgba(75, 85, 99, 0.3)' : 'rgba(0, 0, 0, 0.1)',
  legend: isDarkMode.value ? '#e5e7eb' : '#374151'
}))

// Get color for a specific model
const getModelColor = (modelName) => {
  const index = (usageStats.value?.modelStats || []).findIndex((m) => m.name === modelName)
  return modelColors[index % modelColors.length]
}

// Calculate percentage for a model
const calculatePercentage = (model) => {
  const total = (usageStats.value?.modelStats || []).reduce(
    (sum, m) => sum + (m.totalTokens || 0),
    0
  )
  if (total === 0) return 0
  return ((model.totalTokens / total) * 100).toFixed(1)
}

// Get usage details sorted by date (descending)
const usageDetails = computed(() => {
  if (!usageStats.value?.dailyStats) return []
  return [...usageStats.value.dailyStats].sort((a, b) => {
    return new Date(b.date) - new Date(a.date)
  })
})

// Create model usage pie chart
const createModelUsageChart = () => {
  if (!modelUsageChart.value || !usageStats.value?.modelStats) {
    return
  }

  if (modelUsageChartInstance) {
    modelUsageChartInstance.destroy()
  }

  const data = usageStats.value.modelStats

  modelUsageChartInstance = new Chart(modelUsageChart.value, {
    type: 'doughnut',
    data: {
      labels: data.map((d) => d.name),
      datasets: [
        {
          data: data.map((d) => d.totalTokens || 0),
          backgroundColor: modelColors,
          borderWidth: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            padding: 15,
            usePointStyle: true,
            font: { size: 12 },
            color: chartColors.value.legend
          }
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              const label = context.label || ''
              const value = formatNumber(context.parsed)
              const percentage = calculatePercentage(data[context.dataIndex])
              return `${label}: ${value} (${percentage}%)`
            }
          }
        }
      }
    }
  })
}

// Create usage trend chart
const createUsageTrendChart = () => {
  if (!usageTrendChart.value || !usageStats.value?.dailyStats) {
    return
  }

  if (usageTrendChartInstance) {
    usageTrendChartInstance.destroy()
  }

  const data = usageStats.value.dailyStats

  usageTrendChartInstance = new Chart(usageTrendChart.value, {
    type: 'line',
    data: {
      labels: data.map((d) => d.date),
      datasets: [
        {
          label: '请求数',
          data: data.map((d) => d.requests || 0),
          borderColor: '#3B82F6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          tension: 0.3,
          yAxisID: 'y1'
        },
        {
          label: 'Token 总量',
          data: data.map((d) => (d.inputTokens || 0) + (d.outputTokens || 0)),
          borderColor: '#10B981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: 0.3
        },
        {
          label: '费用 (USD)',
          data: data.map((d) => d.cost || 0),
          borderColor: '#F59E0B',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          tension: 0.3,
          yAxisID: 'y2'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: chartColors.value.legend
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: function (context) {
              const label = context.dataset.label || ''
              let value = context.parsed.y

              if (label === '费用 (USD)') {
                return `${label}: $${value.toFixed(4)}`
              } else if (label === '请求数') {
                return `${label}: ${value.toLocaleString()} 次`
              } else {
                return `${label}: ${formatNumber(value)}`
              }
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: chartColors.value.text },
          grid: { color: chartColors.value.grid }
        },
        y: {
          type: 'linear',
          position: 'left',
          min: 0,
          title: {
            display: true,
            text: 'Token 数量',
            color: chartColors.value.text
          },
          ticks: {
            callback: (value) => formatNumber(value),
            color: chartColors.value.text
          },
          grid: { color: chartColors.value.grid }
        },
        y1: {
          type: 'linear',
          position: 'right',
          min: 0,
          title: {
            display: true,
            text: '请求数',
            color: chartColors.value.text
          },
          grid: { drawOnChartArea: false },
          ticks: {
            callback: (value) => value.toLocaleString(),
            color: chartColors.value.text
          }
        },
        y2: {
          type: 'linear',
          display: false,
          position: 'right',
          min: 0
        }
      }
    }
  })
}

// Load usage statistics
const loadUsageStats = async () => {
  loading.value = true
  try {
    const stats = await userStore.getUserUsageStats({ period: selectedPeriod.value })

    usageStats.value = stats

    // Set loading to false first so v-if condition is satisfied
    loading.value = false

    // Wait for DOM update before creating charts
    await nextTick()
    createModelUsageChart()
    createUsageTrendChart()
  } catch (error) {
    console.error('Failed to load usage stats:', error)
    showToast('加载使用统计失败', 'error')
    loading.value = false
  }
}

// Watch for theme changes and update charts
watch(isDarkMode, () => {
  createModelUsageChart()
  createUsageTrendChart()
})

// Cleanup on unmount
onUnmounted(() => {
  if (modelUsageChartInstance) {
    modelUsageChartInstance.destroy()
  }
  if (usageTrendChartInstance) {
    usageTrendChartInstance.destroy()
  }
})

onMounted(() => {
  loadUsageStats()
})
</script>
