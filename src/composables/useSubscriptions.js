// FILE: src/composables/useSubscriptions.js
import { ref, computed, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useDataStore } from '../stores/useDataStore';
import { useToastStore } from '../stores/toast.js';
import { fetchNodeCount, batchUpdateNodes } from '../lib/api.js';
import { handleError } from '../utils/errorHandler.js';
import { TIMING } from '../constants/timing.js';
import { t } from '../i18n/index.js';

const isDev = import.meta.env.DEV;

export function useSubscriptions(markDirty) {
  const { showToast } = useToastStore();
  const dataStore = useDataStore();
  // Rename the store ref to avoid confusion, as it contains ALL items
  const { subscriptions: allSubscriptions } = storeToRefs(dataStore);

  // Filtered computed property: Only http/https links are "Subscriptions"
  const subscriptions = computed(() => {
    return (allSubscriptions.value || []).filter(sub => sub.url && /^https?:\/\//.test(sub.url));
  });

  const searchQuery = ref('');
  const subscriptionFilters = ref({ status: 'all', proxy: 'all', update: 'all', expiry: 'all', sort: 'default' });
  const parseUpdateTime = (sub) => {
    const value = sub?.lastUpdate ?? sub?.lastUpdated;
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const getExpiryTime = (sub) => {
    const value = Number(sub?.userInfo?.expire);
    return value > 0 ? value * 1000 : 0;
  };
  const getEffectiveUpdateMode = (sub) => {
    if (sub?.autoUpdateInterval === null || sub?.autoUpdateInterval === undefined) return 'follow';
    return Number(sub.autoUpdateInterval) > 0 ? 'custom' : 'manual';
  };
  const filteredSubscriptions = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();
    const filters = subscriptionFilters.value;
    const now = Date.now();
    const filtered = subscriptions.value.filter((sub) => {
      const expiry = getExpiryTime(sub);
      const matchesExpiry = filters.expiry === 'all'
        || (filters.expiry === 'unknown' && !expiry)
        || (filters.expiry === 'active' && expiry > now + 7 * 24 * 60 * 60 * 1000)
        || (filters.expiry === 'soon' && expiry > now && expiry <= now + 7 * 24 * 60 * 60 * 1000)
        || (filters.expiry === 'expired' && expiry > 0 && expiry <= now);
      const matchesQuery = !query || [
      sub.name,
      sub.description,
      sub.remark,
      sub.note,
      sub.website,
      sub.url,
      sub.customId
      ].some(value => String(value || '').toLowerCase().includes(query));
      return matchesQuery
        && (filters.status === 'all' || (filters.status === 'enabled' ? sub.enabled !== false : sub.enabled === false))
        && (filters.proxy === 'all' || (filters.proxy === 'enabled' ? Boolean(String(sub.fetchProxy || '').trim()) : !String(sub.fetchProxy || '').trim()))
        && (filters.update === 'all' || getEffectiveUpdateMode(sub) === filters.update)
        && matchesExpiry;
    });

    if (filters.sort === 'updated-desc') filtered.sort((a, b) => parseUpdateTime(b) - parseUpdateTime(a));
    if (filters.sort === 'updated-asc') filtered.sort((a, b) => (parseUpdateTime(a) || Infinity) - (parseUpdateTime(b) || Infinity));
    if (filters.sort === 'expiry-asc') filtered.sort((a, b) => (getExpiryTime(a) || Infinity) - (getExpiryTime(b) || Infinity));
    if (filters.sort === 'name-asc') filtered.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return filtered;
  });

  const subsCurrentPage = ref(1);
  const subsItemsPerPage = 6;

  const enabledSubscriptions = computed(() => subscriptions.value.filter(s => s.enabled !== false));

  const totalRemainingTraffic = computed(() => {
    const REASONABLE_TRAFFIC_LIMIT_BYTES = 10 * 1024 * 1024 * 1024 * 1024 * 1024; // 10 PB in bytes
    return subscriptions.value.reduce((acc, sub) => {
      if (sub.excludeTraffic) return acc;
      if (
        sub.enabled !== false &&
        sub.userInfo &&
        Number(sub.userInfo.total) > 0 &&
        Number(sub.userInfo.total) < REASONABLE_TRAFFIC_LIMIT_BYTES
      ) {
        const total = Number(sub.userInfo.total);
        const used = Number(sub.userInfo.upload || 0) + Number(sub.userInfo.download || 0);
        const remaining = total - used;
        return acc + Math.max(0, remaining);
      }
      return acc;
    }, 0);
  });

  const subsTotalPages = computed(() => Math.ceil(filteredSubscriptions.value.length / subsItemsPerPage));
  const paginatedSubscriptions = computed(() => {
    const start = (subsCurrentPage.value - 1) * subsItemsPerPage;
    const end = start + subsItemsPerPage;
    return filteredSubscriptions.value.slice(start, end);
  });

  watch(searchQuery, () => {
    subsCurrentPage.value = 1;
  });
  watch(subscriptionFilters, () => {
    subsCurrentPage.value = 1;
  }, { deep: true });

  function changeSubsPage(page) {
    if (page < 1 || page > subsTotalPages.value) return;
    subsCurrentPage.value = page;
  }

  async function handleUpdateNodeCount(subId, isInitialLoad = false) {
    // Find in the filtered list
    const subToUpdate = subscriptions.value.find(s => s.id === subId);
    if (!subToUpdate) return;
    // Double check URL just in case
    if (!subToUpdate.url.startsWith('http')) return;

    if (!isInitialLoad) {
      subToUpdate.isUpdating = true;
    }

    // 添加超时保护:如果30秒后仍在更新状态,强制重置
    const timeoutId = setTimeout(() => {
      if (subToUpdate.isUpdating) {
        console.warn(`[handleUpdateNodeCount] Timeout protection triggered for ${subToUpdate.name}`);
        subToUpdate.isUpdating = false;
        if (!isInitialLoad) {
          showToast(t('subscriptions.updateTimeoutReset', { name: subToUpdate.name || t('subscriptions.fallbackName') }), 'warning');
        }
      }
    }, TIMING.REQUEST_TIMEOUT_MS);

    try {
      const result = await fetchNodeCount(
        subToUpdate.url,
        subToUpdate.fetchProxy,
        Boolean(subToUpdate.plusAsSpace),
        subToUpdate.customUserAgent,
        subToUpdate.name
      );

      // 清除超时保护
      clearTimeout(timeoutId);

                // 检查是否成功
                if (!result.success) {
                    const subscriptionName = subToUpdate.name || t('subscriptions.fallbackName');
                    let userMessage = t('subscriptions.updateFailed', { name: subscriptionName });

                    // 根据 errorType 提供更友好的错误提示
                    switch (result.errorType) {
                        case 'timeout':
                            userMessage = t('subscriptions.updateTimeoutRetry', { name: subscriptionName });
                            break;
                        case 'network':
                            userMessage = t('subscriptions.networkFailed', { name: subscriptionName });
                            break;
                        case 'server':
                            userMessage = t('subscriptions.serverError', { name: subscriptionName });
                            break;
                        default:
                            userMessage = t('subscriptions.updateFailedWithMessage', { name: subscriptionName, message: result.error || t('subscriptions.unknownError') });
                    }

                    if (result.errorType === 'server' && (result.error || result.status)) {
                        userMessage = t('subscriptions.updateFailedWithMessage', { name: subscriptionName, message: result.error || `HTTP ${result.status}` });
                    }

                    // 只有非静默加载时才显示 Toast
                    if (!isInitialLoad) showToast(userMessage, 'error');
                    console.error(`[handleUpdateNodeCount] Failed for ${subToUpdate.name}:`, result.error);

                    // 重要: 记录错误到本地对象中(非持久化,仅用于UI展示,直到下次持久化保存)
                    subToUpdate.lastError = result.error;
                    if (subToUpdate.enableNodeCache !== true) {
                        subToUpdate.nodeCount = 0;
                        subToUpdate.userInfo = null;
                        if (!isInitialLoad) {
                            markDirty();
                            void dataStore.saveData();
                        }
                    }
                    return; // 开启保护性缓存节点时，失败保留旧值
                }

                // 成功获取数据
                const data = result.data.data || result.data; // 兼容后端返回结构
                subToUpdate.nodeCount = data.count || 0;
                subToUpdate.userInfo = data.userInfo || null;
                subToUpdate.lastError = null; // 成功后清除错误状态
                subToUpdate.lastUpdate = new Date().toISOString();

                if (!isInitialLoad) {
                    showToast(t('subscriptions.updateSuccess', { name: subToUpdate.name || t('subscriptions.fallbackName') }), 'success');
                    markDirty();
                    // 自动保存手动更新的结果
                    void dataStore.saveData();
                }
    } catch (error) {
      // 清除超时保护
      clearTimeout(timeoutId);

      handleError(error, 'Subscription Update Error', {
        subscriptionName: subToUpdate.name,
        subscriptionId: subId,
        isInitialLoad
      });

      const errorMessage = t('subscriptions.updateUnexpectedError', { name: subToUpdate.name || t('subscriptions.fallbackName') });
      if (!isInitialLoad) {
        showToast(errorMessage, 'error');
      }
    } finally {
      if (subToUpdate) subToUpdate.isUpdating = false;
    }
  }

  function addSubscription(sub) {
    dataStore.addSubscription(sub);
    subsCurrentPage.value = 1;
    handleUpdateNodeCount(sub.id);
    markDirty();
  }

  function updateSubscription(updatedSub) {
    // Verify it exists in our filtered list
    const originalSub = subscriptions.value.find(s => s.id === updatedSub.id);
    if (originalSub) {
      const urlChanged = originalSub.url !== updatedSub.url;
      dataStore.updateSubscription(updatedSub.id, updatedSub);

      if (urlChanged) {
        // Re-fetch from filtered list to get the reactive object
        const sub = subscriptions.value.find(s => s.id === updatedSub.id);
        if (sub) {
          sub.nodeCount = 0;
          handleUpdateNodeCount(sub.id);
        }
      }
      markDirty();
    }
  }

  function deleteSubscription(subId) {
    dataStore.removeSubscription(subId);
    // 清理组合订阅中对该订阅源的引用
    dataStore.removeSubscriptionFromProfiles(subId);
    if (paginatedSubscriptions.value.length === 0 && subsCurrentPage.value > 1) {
      subsCurrentPage.value--;
    }
    markDirty();
  }

  function deleteAllSubscriptions() {
    // Only remove the subscriptions visible in this composable (i.e. HTTP subs)
    // Avoid removing manual nodes which are also in dataStore but filtered out here
    const idsToRemove = subscriptions.value.map(s => s.id);

    // 如果没有订阅，提示并返回
    if (idsToRemove.length === 0) {
      showToast(t('subscriptions.noSubscriptionsToDelete'), 'info');
      return;
    }

    idsToRemove.forEach(id => dataStore.removeSubscription(id));
    // 清理组合订阅中对这些订阅源的引用
    dataStore.removeSubscriptionFromProfiles(idsToRemove);

    subsCurrentPage.value = 1;
    markDirty();
    showToast(t('subscriptions.clearedCount', { count: idsToRemove.length }), 'success');
  }

  async function addSubscriptionsFromBulk(subs) {
    // Reverse insert to maintain order
    for (let i = subs.length - 1; i >= 0; i--) {
      dataStore.addSubscription(subs[i]);
    }
    markDirty();

    const subsToUpdate = subs.filter(sub => sub.url && sub.url.startsWith('http'));

    if (subsToUpdate.length > 0) {
      showToast(t('subscriptions.batchUpdating', { count: subsToUpdate.length }), 'info');

      // Use individual updates instead of batch backend update
      // This avoids 400 error because backend doesn't have these IDs yet.
      const updatePromises = subsToUpdate.map(sub => handleUpdateNodeCount(sub.id));

      try {
        await Promise.allSettled(updatePromises);
        showToast(t('subscriptions.bulkImportUpdateDone'), 'success');
      } catch (e) {
        console.error("Batch update finished with some errors");
      }
    } else {
      showToast(t('subscriptions.bulkImportDone'), 'success');
    }
  }

  async function batchUpdateAllSubscriptions() {
    const subsToUpdate = subscriptions.value.filter(sub =>
      sub.enabled && sub.url && sub.url.startsWith('http') && !sub.isUpdating
    );

    if (subsToUpdate.length === 0) {
      showToast(t('subscriptions.noRefreshableSubscriptions'), 'info');
      return;
    }

    subsToUpdate.forEach(sub => { sub.isUpdating = true; });
    showToast(t('subscriptions.refreshing', { count: subsToUpdate.length }), 'info');

    try {
      const result = await batchUpdateNodes(subsToUpdate.map(sub => sub.id));

      if (result && result.success) {
        let successCount = 0;
        const resultList = Array.isArray(result.results) ? result.results : [];

        resultList.forEach(updateResult => {
          const id = updateResult.subscriptionId || updateResult.id;
          const sub = subscriptions.value.find(s => s.id === id);
          if (!sub) return;

          if (updateResult.success) {
            sub.nodeCount = updateResult.nodeCount || 0;
            successCount++;
          }
        });

        for (const sub of subsToUpdate) {
          try {
            const result = await fetchNodeCount(sub.url);
            if (result.success && result.data.userInfo) {
              sub.userInfo = result.data.userInfo;
            }
          } catch (error) {
            if (isDev) {
              console.debug('[Subscriptions] Failed to fetch node info during batch update:', error);
            }
          }
        }

        const failedCount = subsToUpdate.length - successCount;
        showToast(t('subscriptions.refreshDone', { success: successCount, total: subsToUpdate.length, failed: failedCount }), 'success');
        markDirty();
      } else {
        showToast(t('subscriptions.refreshFailed', { message: result?.message || t('subscriptions.unknownError') }), 'error');
        for (const sub of subsToUpdate) {
          await handleUpdateNodeCount(sub.id);
        }
      }
    } catch (error) {
      handleError(error, 'Batch Subscription Update Error', { subscriptionCount: subsToUpdate.length });
      showToast(t('subscriptions.refreshFallback'), 'error');
      for (const sub of subsToUpdate) {
        await handleUpdateNodeCount(sub.id);
      }
    } finally {
      subsToUpdate.forEach(sub => { sub.isUpdating = false; });
    }
  }

  // ========== 定时自动更新功能 ==========
  let subscriptionUpdateTimerId = null;
  let isAutoUpdateRunning = false;

  function getEffectiveUpdateInterval(sub) {
    const hasSubscriptionSetting = sub?.autoUpdateInterval !== null && sub?.autoUpdateInterval !== undefined;
    const subscriptionInterval = Number(sub?.autoUpdateInterval);
    if (hasSubscriptionSetting) return subscriptionInterval > 0 ? subscriptionInterval : 0;
    const globalInterval = Number(dataStore.settings?.autoUpdateInterval);
    return globalInterval > 0 ? globalInterval : 0;
  }

  async function autoUpdateAllSubscriptions() {
    if (isAutoUpdateRunning) return;
    isAutoUpdateRunning = true;
    try {
      const now = Date.now();
      const subsToUpdate = subscriptions.value.filter(sub => {
        const interval = getEffectiveUpdateInterval(sub);
        if (!sub.enabled || !sub.url?.startsWith('http') || sub.isUpdating || interval <= 0) return false;

        const rawLastUpdate = sub.lastUpdate ?? sub.lastUpdated;
        const lastUpdate = typeof rawLastUpdate === 'number'
          ? rawLastUpdate
          : (Date.parse(rawLastUpdate || '') || Number(sub.lastAutoUpdatedAt) || 0);
        return !lastUpdate || now - lastUpdate >= interval * 60 * 1000;
      });

      await Promise.allSettled(subsToUpdate.map(async (sub) => {
        try {
          await handleUpdateNodeCount(sub.id, true);
        } catch (error) {
          console.warn(`[AutoUpdate] Subscription refresh failed: ${sub.name || sub.id}`, error);
        }
      }));
    } catch (e) {
      console.error('Auto update failed', e);
    } finally {
      isAutoUpdateRunning = false;
    }
  }

  function startSubscriptionAutoUpdate() {
    if (subscriptionUpdateTimerId) return;
    void autoUpdateAllSubscriptions();
    subscriptionUpdateTimerId = setInterval(() => {
      void autoUpdateAllSubscriptions();
    }, 60 * 1000);
  }

  function startAutoUpdate(intervalMinutes = null) {
    // 机场级设置优先，全局设置只作为未单独配置机场的默认值。
    startSubscriptionAutoUpdate();
    if (isDev && intervalMinutes !== null) console.debug(`[AutoUpdate] Settings changed: ${intervalMinutes} minutes`);
  }

  function stopAutoUpdate() {
    if (subscriptionUpdateTimerId) {
      clearInterval(subscriptionUpdateTimerId);
      subscriptionUpdateTimerId = null;
      if (isDev) console.debug('[AutoUpdate] Stopped');
    }
  }

  function restartAutoUpdate(intervalMinutes) {
    stopAutoUpdate();
    startAutoUpdate(intervalMinutes);
  }

  function reorderSubscriptions(newOrder) {
    // 1. Get all Manual Nodes (to preserve them)
    // We can't rely just on manualNodes computed because it might be filtered or not imported here.
    // Instead, filter from source of truth: allSubscriptions
    const currentManualNodes = (allSubscriptions.value || []).filter(item => !item.url || !/^https?:\/\//.test(item.url));

    // 2. Combine New Ordered Subscriptions + Existing Manual Nodes
    // Logic: Manual Nodes at top, Subscriptions at bottom
    const mergedList = [...currentManualNodes, ...newOrder];

    // 3. Update Store
    dataStore.overwriteSubscriptions(mergedList);

    // 4. Mark Dirty
    markDirty();
  }

  return {
    subscriptions,
    filteredSubscriptions,
    searchQuery,
    subscriptionFilters,
    subsCurrentPage,
    subsTotalPages,
    paginatedSubscriptions,
    totalRemainingTraffic,
    enabledSubscriptionsCount: computed(() => enabledSubscriptions.value.length),
    changeSubsPage,
    addSubscription,
    updateSubscription,
    deleteSubscription,
    deleteAllSubscriptions,
    addSubscriptionsFromBulk,
    handleUpdateNodeCount,
    batchUpdateAllSubscriptions,
    startAutoUpdate,
    stopAutoUpdate,
    restartAutoUpdate,
    reorderSubscriptions,
  };
}
