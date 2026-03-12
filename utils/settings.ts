export interface BloomSettings {
  blossomServers: string[];
  nostrRelays: string[];
  publishToNostr: boolean;
}

const DEFAULTS: BloomSettings = {
  blossomServers: ['https://blossom.primal.net', 'https://blossom.nostr.build'],
  nostrRelays: ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.nostr.band'],
  publishToNostr: false,
};

export async function getSettings(): Promise<BloomSettings> {
  const result = await browser.storage.local.get('settings');
  if (!result.settings) return { ...DEFAULTS };
  return { ...DEFAULTS, ...result.settings };
}

export async function saveSettings(settings: Partial<BloomSettings>): Promise<void> {
  const current = await getSettings();
  await browser.storage.local.set({ settings: { ...current, ...settings } });
}
