import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { useSubscriptionForms } from '../../src/composables/useSubscriptionForms.js';
import AdvancedOptions from '../../src/components/modals/SubscriptionEditModal/AdvancedOptions.vue';
import Card from '../../src/components/ui/Card.vue';
import { createI18n } from '../../src/i18n/index.js';

function withZhI18n(stubs = {}) {
  return {
    plugins: [createI18n({ initialLocale: 'zh-CN' })],
    stubs
  };
}

vi.mock('../../src/stores/toast.js', () => ({
  useToastStore: () => ({
    showToast: vi.fn()
  })
}));

describe('subscription official website field', () => {
  it('initializes official website as an independent field for new subscriptions', () => {
    const { openAdd, editingSubscription } = useSubscriptionForms({
      addSubscription: vi.fn(),
      updateSubscription: vi.fn()
    });

    openAdd();

    expect(editingSubscription.value.website).toBe('');
  });

  it('renders website input above notes in advanced options', () => {
    const wrapper = mount(AdvancedOptions, {
      props: {
        editingSubscription: {
          customUserAgent: '',
          website: '',
          notes: '',
          enableNodeCache: false,
          plusAsSpace: false
        }
      },
      global: withZhI18n()
    });

    const websiteInput = wrapper.get('#sub-edit-website');
    const notesTextarea = wrapper.get('textarea');

    expect(wrapper.text()).toContain('官网');
    expect(websiteInput.attributes('placeholder')).toBe('https://example.com');
    expect(websiteInput.element.compareDocumentPosition(notesTextarea.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses the explicit website field for the card website link instead of parsing notes', () => {
    const wrapper = mount(Card, {
      props: {
        misub: {
          id: 'sub_1',
          name: '测试机场',
          url: 'https://api.example.com/sub?target=clash',
          website: 'wd-gold.net/clientarea.php',
          notes: '备注里没有可识别官网',
          enabled: true,
          nodeCount: 0
        }
      },
      global: withZhI18n({
        Switch: { template: '<button class="switch-stub"></button>' }
      })
    });

    const link = wrapper.get('[data-testid="subscription-website-link"]');
    expect(link.attributes('href')).toBe('https://wd-gold.net/clientarea.php');
    expect(link.text()).toContain('官网');
  });

  it('shows the website link before notes on the subscription card', () => {
    const wrapper = mount(Card, {
      props: {
        misub: {
          id: 'sub_1',
          name: '测试机场',
          url: 'https://api.example.com/sub?target=clash',
          website: 'https://wd-gold.net/clientarea.php',
          notes: '30/月 IPLC专线',
          enabled: true,
          nodeCount: 0
        }
      },
      global: withZhI18n({
        Switch: { template: '<button class="switch-stub"></button>' }
      })
    });

    const meta = wrapper.get('[data-testid="subscription-footer-meta"]');
    const websiteLink = wrapper.get('[data-testid="subscription-website-link"]');
    const notes = wrapper.get('[data-testid="subscription-notes"]');

    expect(websiteLink.element.compareDocumentPosition(notes.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(meta.text()).toMatch(/^官网\s*30\/月 IPLC专线/);
  });

  it('can hide the subscription URL without changing the copied value', async () => {
    const url = 'https://api.example.com/sub?token=private-token';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });

    const wrapper = mount(Card, {
      props: {
        misub: { id: 'sub_1', name: '测试机场', url, enabled: true, nodeCount: 0 }
      },
      global: withZhI18n({
        Switch: { template: '<button class="switch-stub"></button>' }
      })
    });

    const urlInput = wrapper.get('input[readonly]');
    const visibilityButton = wrapper.get('button[aria-label="显示订阅地址"]');
    expect(urlInput.element.value).not.toContain('private-token');
    expect(urlInput.element.value).toMatch(/^\*+$/);

    await visibilityButton.trigger('click');
    expect(urlInput.element.value).toBe(url);

    await wrapper.get('button[aria-label="复制"]').trigger('click');
    expect(writeText).toHaveBeenCalledWith(url);
  });

  it('shows the source-specific auto-update strategy on the subscription card', () => {
    const wrapper = mount(Card, {
      props: {
        globalUpdateInterval: 5,
        misub: {
          id: 'sub_1',
          name: '测试机场',
          url: 'https://api.example.com/sub',
          autoUpdateInterval: 30,
          enabled: true,
          nodeCount: 0
        }
      },
      global: withZhI18n({
        Switch: { template: '<button class="switch-stub"></button>' }
      })
    });

    expect(wrapper.text()).toContain('自动更新策略');
    expect(wrapper.text()).toContain('机场独立（30 分钟）');
  });

  it('uses graduated colors for subscription expiry warnings', () => {
    const createWrapper = (daysRemaining) => mount(Card, {
      props: {
        misub: {
          id: 'sub_1',
          name: '即将到期机场',
          url: 'https://api.example.com/sub',
          enabled: true,
          nodeCount: 0,
          userInfo: { upload: 0, download: 0, total: 100, expire: Math.floor(Date.now() / 1000) + daysRemaining * 24 * 60 * 60 }
        }
      },
      global: withZhI18n({
        Switch: { template: '<button class="switch-stub"></button>' }
      })
    });

    expect(createWrapper(30).get('[data-testid="subscription-expiry-badge"]').classes()).toContain('text-amber-600');
    expect(createWrapper(15).get('[data-testid="subscription-expiry-badge"]').classes()).toContain('text-orange-600');
    expect(createWrapper(7).get('[data-testid="subscription-expiry-badge"]').classes()).toContain('text-red-600');
    expect(createWrapper(-1).get('[data-testid="subscription-expiry-badge"]').classes()).toContain('text-red-700');
  });
});
