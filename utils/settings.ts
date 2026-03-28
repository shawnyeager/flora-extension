export type SharingMode = 'public' | 'unlisted' | 'private';

export interface FloraSettings {
  blossomServers: string[];
  nostrRelays: string[];
  publishToNostr: boolean;
  nostrPubkey: string; // hex pubkey, entered as npub in settings UI
  selectedCameraDeviceId: string | null; // deviceId from enumerateDevices, null = default
  defaultSharingMode: SharingMode;
}

const DEFAULTS: FloraSettings = {
  blossomServers: ['https://blossom.primal.net', 'https://blossom.nostr.build'],
  nostrRelays: ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.nostr.band'],
  publishToNostr: false,
  nostrPubkey: '',
  selectedCameraDeviceId: null,
  defaultSharingMode: 'public',
};

export async function getSettings(): Promise<FloraSettings> {
  const result = await browser.storage.local.get('settings');
  const stored = result.settings as Partial<FloraSettings> | undefined;
  if (!stored) return { ...DEFAULTS };
  const merged = { ...DEFAULTS, ...stored };
  // Migration: derive defaultSharingMode from publishToNostr for existing users
  if (!stored.defaultSharingMode) {
    merged.defaultSharingMode = merged.publishToNostr ? 'public' : 'unlisted';
  }
  return merged;
}

export async function saveSettings(settings: Partial<FloraSettings>): Promise<void> {
  const current = await getSettings();
  await browser.storage.local.set({ settings: { ...current, ...settings } });
}
