import { defineConfig } from 'wxt';
import pkg from './package.json';

export default defineConfig({
  manifest: {
    name: 'Flora',
    description: 'Record your screen, share anywhere. Stored on Blossom, publish to Nostr.',
    version: pkg.version,
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
