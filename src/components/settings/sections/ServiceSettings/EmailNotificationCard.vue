<script setup>
import { computed } from 'vue';
import Switch from '../../../ui/Switch.vue';
import Input from '../../../ui/Input.vue';
import { useI18n } from '../../../../i18n/index.js';

const props = defineProps({
  settings: { type: Object, required: true }
});

const { t } = useI18n();
const defaultConfig = {
  enabled: false,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: '',
  smtpPassword: '',
  from: '',
  to: ''
};

const emailConfig = computed({
  get() {
    if (!props.settings.emailNotification) {
      props.settings.emailNotification = { ...defaultConfig };
    }
    return props.settings.emailNotification;
  },
  set(value) {
    props.settings.emailNotification = value;
  }
});
</script>

<template>
  <section class="bg-white/90 dark:bg-gray-900/70 misub-radius-lg p-6 border border-gray-100/80 dark:border-white/10 shadow-sm space-y-6">
    <div class="flex items-center justify-between gap-4">
      <div>
        <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('settings.emailNotificationTitle') }}</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('settings.emailNotificationDesc') }}</p>
      </div>
      <Switch v-model="emailConfig.enabled" />
    </div>

    <div v-if="emailConfig.enabled" class="space-y-5">
      <div class="rounded-lg border border-sky-200/80 bg-sky-50/70 p-3 text-xs text-sky-700 dark:border-sky-400/20 dark:bg-sky-500/10 dark:text-sky-200">
        {{ t('settings.emailNotificationProviderHint') }}
      </div>
      <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Input v-model="emailConfig.smtpHost" :label="t('settings.emailSmtpHost')" placeholder="smtp.example.com" />
        <Input v-model.number="emailConfig.smtpPort" :label="t('settings.emailSmtpPort')" type="number" min="1" max="65535" placeholder="465" />
        <Input v-model="emailConfig.smtpUser" :label="t('settings.emailSmtpUser')" placeholder="account@example.com" />
        <Input v-model="emailConfig.smtpPassword" :label="t('settings.emailSmtpPassword')" type="password" :placeholder="t('settings.emailSmtpPasswordPlaceholder')" />
        <Input v-model="emailConfig.from" :label="t('settings.emailFrom')" placeholder="MiSub <noreply@example.com>" />
        <Input v-model="emailConfig.to" :label="t('settings.emailTo')" :placeholder="t('settings.emailToPlaceholder')" />
      </div>
      <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input v-model="emailConfig.smtpSecure" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500">
        {{ t('settings.emailSmtpSecure') }}
      </label>
      <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('settings.emailToHint') }}</p>
    </div>
  </section>
</template>
