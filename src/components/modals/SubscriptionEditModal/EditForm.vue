<script setup>
const props = defineProps({
  editingSubscription: {
    type: Object,
    required: true
  }
});
import Input from '../../ui/Input.vue';
import Switch from '../../ui/Switch.vue';
import { ref, watch } from 'vue';
import { fetchNodeCount } from '../../../lib/api.js';
import { useToastStore } from '../../../stores/toast.js';
import { useI18n } from '../../../i18n/index.js';

const DEFAULT_FETCH_PROXY = String(import.meta.env.VITE_DEFAULT_FETCH_PROXY || '').trim();

const { showToast } = useToastStore();
const { t } = useI18n();

// 使用独立的本地状态，防止用户清空输入框时开关自动跳回关闭状态
const useFetchProxy = ref(false);
const isTestingProxy = ref(false);

// 当弹窗传入新订阅信息时，初始化开关状态
watch(() => props.editingSubscription, (newSub) => {
  if (newSub) {
    newSub.autoUpdateInterval = Number(newSub.autoUpdateInterval) || 0;
    useFetchProxy.value = !!newSub.fetchProxy;
  }
}, { immediate: true });

// 当用户主动关闭开关时，清理绑定的代理地址
watch(useFetchProxy, (val) => {
  if (!props.editingSubscription) return;

  if (!val) {
    props.editingSubscription.fetchProxy = '';
    return;
  }

  if (!props.editingSubscription.fetchProxy && DEFAULT_FETCH_PROXY) {
    props.editingSubscription.fetchProxy = DEFAULT_FETCH_PROXY;
  }
});

const testProxyConnectivity = async () => {
  if (!props.editingSubscription.fetchProxy || !props.editingSubscription.url) {
    showToast(t('subscriptions.proxyRequired'), 'warning');
    return;
  }
  isTestingProxy.value = true;
  try {
    const res = await fetchNodeCount(
      props.editingSubscription.url,
      props.editingSubscription.fetchProxy,
      props.editingSubscription.plusAsSpace,
      props.editingSubscription.customUserAgent
    );
    if (res.success) {
      showToast(t('subscriptions.proxyTestSuccess', { count: res.data.count }), 'success');
    } else {
      showToast(t('subscriptions.proxyTestFailed', { message: res.error }), 'error');
    }
  } catch (err) {
    showToast(t('subscriptions.proxyTestError', { message: err.message }), 'error');
  } finally {
    isTestingProxy.value = false;
  }
};
</script>

<template>
  <!-- 订阅名称 -->
  <div>
    <Input 
      id="sub-edit-name" 
      v-model="editingSubscription.name" 
      :label="t('subscriptions.nameLabel')"
      :placeholder="t('subscriptions.nameAutoPlaceholder')"
    />
  </div>

  <!-- 订阅链接 -->
  <div>
    <Input 
      id="sub-edit-url" 
      v-model="editingSubscription.url" 
      :label="t('subscriptions.urlLabel')"
      placeholder="https://..."
      class="font-mono"
    />
  </div>

  <!-- 订阅自动更新 -->
  <div class="pt-2 border-t border-gray-100 dark:border-gray-700">
    <label for="sub-edit-auto-update" class="block text-sm font-medium text-gray-700 dark:text-gray-200">
      {{ t('subscriptions.autoUpdateIntervalLabel') }}
    </label>
    <select
      id="sub-edit-auto-update"
      v-model.number="editingSubscription.autoUpdateInterval"
      class="mt-2 w-full appearance-none rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 dark:border-white/10 dark:bg-white/[0.035] dark:text-[#f7f8f8]"
    >
      <option :value="0">{{ t('subscriptions.autoUpdateDisabled') }}</option>
      <option :value="15">15 {{ t('subscriptions.minutes') }}</option>
      <option :value="30">30 {{ t('subscriptions.minutes') }}</option>
      <option :value="60">1 {{ t('subscriptions.hours') }}</option>
      <option :value="360">6 {{ t('subscriptions.hours') }}</option>
      <option :value="720">12 {{ t('subscriptions.hours') }}</option>
      <option :value="1440">1 {{ t('subscriptions.days') }}</option>
      <option :value="4320">3 {{ t('subscriptions.days') }}</option>
      <option :value="10080">7 {{ t('subscriptions.days') }}</option>
    </select>
    <p class="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{{ t('subscriptions.autoUpdateIntervalHint') }}</p>
  </div>

  <!-- 专属拉取代理 -->
  <div class="pt-2 border-t border-gray-100 dark:border-gray-700">
    <div class="flex items-center justify-between mb-2">
      <div>
         <span class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ t('subscriptions.fetchProxyTitle') }}</span>
         <p class="text-xs text-gray-500 mt-0.5">{{ t('subscriptions.fetchProxyDesc') }}</p>
      </div>
      <Switch v-model="useFetchProxy" />
    </div>

    <!-- 代理输入框 (动画展开) -->
    <div v-if="useFetchProxy" class="mt-3 space-y-2 animate-fade-in">
      <div class="flex gap-2">
        <Input
          id="sub-edit-proxy" 
          v-model="editingSubscription.fetchProxy"
          placeholder="例如: https://my-proxy.vercel.app/api?url="
          class="font-mono text-sm flex-1"
        />
        <button 
          type="button"
          @click="testProxyConnectivity"
          :disabled="isTestingProxy || !editingSubscription.fetchProxy || !editingSubscription.url"
          class="h-[46px] px-4 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 rounded-lg text-sm font-medium hover:bg-indigo-100 dark:hover:bg-indigo-500/20 disabled:opacity-50 transition-colors shrink-0 flex items-center justify-center whitespace-nowrap"
        >
          <svg v-if="isTestingProxy" class="animate-spin -ml-1 mr-2 h-4 w-4 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <svg v-else xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          {{ isTestingProxy ? t('subscriptions.testing') : t('subscriptions.testProxy') }}
        </button>
      </div>
      <p class="text-[11px] text-indigo-600 dark:text-indigo-400">
        {{ t('subscriptions.fetchProxyHint') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
