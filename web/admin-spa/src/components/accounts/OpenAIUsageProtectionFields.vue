<template>
  <div :class="resolvedContainerClass">
    <label class="mb-1 block text-sm font-semibold text-gray-700 dark:text-gray-300">
      使用量保护
    </label>
    <label class="flex items-start">
      <input
        :checked="autoStopOnFiveHourLimit"
        class="mt-1 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
        type="checkbox"
        @change="emit('update:autoStopOnFiveHourLimit', $event.target.checked)"
      />
      <div class="ml-3">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
          5小时限额使用量达到 95% 时自动停止调度
        </span>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          检测到 Codex 5小时限额使用量达到 95% 时自动暂停，等当前时间窗口重置后自动恢复
        </p>
      </div>
    </label>
    <label class="flex items-start">
      <input
        :checked="autoStopOnWeeklyLimit"
        class="mt-1 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
        type="checkbox"
        @change="emit('update:autoStopOnWeeklyLimit', $event.target.checked)"
      />
      <div class="ml-3">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
          周限额使用量达到 95% 时自动停止调度
        </span>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          检测到周限额使用量达到 95% 时自动暂停，等周限额重置后自动恢复
        </p>
      </div>
    </label>
    <label class="flex items-start">
      <input
        :checked="autoStopOnDailyOveruse"
        class="mt-1 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
        type="checkbox"
        @change="emit('update:autoStopOnDailyOveruse', $event.target.checked)"
      />
      <div class="ml-3">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
          周限额消耗过快时按日均摊限流
        </span>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          将周限额按5天指数递减分配（第1天32%、第2天24%、第3天20%、第4天14%、第5天10%），当日消耗超出均摊上限时停止调度，次日（服务器时区零点）自动恢复
        </p>
      </div>
    </label>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  autoStopOnFiveHourLimit: {
    type: Boolean,
    default: false
  },
  autoStopOnWeeklyLimit: {
    type: Boolean,
    default: false
  },
  autoStopOnDailyOveruse: {
    type: Boolean,
    default: false
  },
  containerClass: {
    type: String,
    default: ''
  }
})

const emit = defineEmits([
  'update:autoStopOnFiveHourLimit',
  'update:autoStopOnWeeklyLimit',
  'update:autoStopOnDailyOveruse'
])

const resolvedContainerClass = computed(() => props.containerClass || 'space-y-3')
</script>
