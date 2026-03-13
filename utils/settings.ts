export interface FloraSettings {
  blossomServers: string[];
  nostrRelays: string[];
  publishToNostr: boolean;
  nostrPubkey: string; // hex pubkey, entered as npub in settings UI
}

const DEFAULTS: FloraSettings = {
  blossomServers: ['https://blossom.primal.net', 'https://blossom.nostr.build'],
  nostrRelays: ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.nostr.band'],
  publishToNostr: false,
  nostrPubkey: '',
};

export async function getSettings(): Promise<FloraSettings> {
  const result = await browser.storage.local.get('settings');
  if (!result.settings) return { ...DEFAULTS };
  return { ...DEFAULTS, ...result.settings };
}

export async function saveSettings(settings: Partial<FloraSettings>): Promise<void> {
  const current = await getSettings();
  await browser.storage.local.set({ settings: { ...current, ...settings } });
}
