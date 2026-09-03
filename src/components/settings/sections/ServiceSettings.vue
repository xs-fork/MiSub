<script setup>
import TransformCard from './ServiceSettings/TransformCard.vue';
import DnsOverrideCard from './ServiceSettings/DnsOverrideCard.vue';
import TelegramCard from './ServiceSettings/TelegramCard.vue';
import CronCard from './ServiceSettings/CronCard.vue';
import EmailNotificationCard from './ServiceSettings/EmailNotificationCard.vue';

defineProps({
  settings: {
    type: Object,
    required: true
  }
});
</script>

<template>
  <div class="space-y-8">
    <TransformCard :settings="settings" />
    <DnsOverrideCard :settings="settings" />
    <TelegramCard :settings="settings" />
    <EmailNotificationCard :settings="settings" />
    <CronCard :settings="settings" />
  </div>
</template>
