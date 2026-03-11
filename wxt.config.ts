import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Bloom',
    description: 'Decentralized screen recording powered by Nostr + Blossom',
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
