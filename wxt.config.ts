import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Flora',
    description: 'Record your screen, share anywhere. Stored on Blossom, publish to Nostr.',
    version: '0.1.0',
    permissions: [
      'offscreen',
      'activeTab',
      'tabs',
      'storage',
      'scripting',
    ],
    host_permissions: ['<all_urls>'],
  },
});
