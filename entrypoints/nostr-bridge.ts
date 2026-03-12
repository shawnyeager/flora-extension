export default defineUnlistedScript(() => {
  console.log('[nostr-bridge] main-world script loaded');

  // This runs in the page's main world — access to window.nostr (NIP-07)
  // Communication with the content script happens via window.postMessage

  const CHANNEL = '__flora_nip07_' + crypto.randomUUID();

  // Signal readiness to the content script via postMessage (CustomEvent.detail doesn't cross worlds)
  window.postMessage({ type: 'flora:bridge:ready', channel: CHANNEL }, '*');

  // Listen for requests from the content script
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL) return;

    const nostr = (window as any).nostr;

    if (event.data.type === 'flora:getPublicKey') {
      if (!nostr) {
        window.postMessage({ channel: CHANNEL, type: 'flora:error', id: event.data.id, error: 'NIP-07 signer not found' }, '*');
        return;
      }
      try {
        const pubkey = await nostr.getPublicKey();
        console.log('[nostr-bridge] getPublicKey returned:', typeof pubkey, pubkey ? String(pubkey).slice(0, 16) : pubkey);
        window.postMessage({ channel: CHANNEL, type: 'flora:publicKey', id: event.data.id, data: pubkey }, '*');
      } catch (err) {
        window.postMessage({ channel: CHANNEL, type: 'flora:error', id: event.data.id, error: String(err) }, '*');
      }
    }

    if (event.data.type === 'flora:signEvent') {
      if (!nostr) {
        window.postMessage({ channel: CHANNEL, type: 'flora:error', id: event.data.id, error: 'NIP-07 signer not found' }, '*');
        return;
      }
      try {
        const signed = await nostr.signEvent(event.data.event);
        window.postMessage({ channel: CHANNEL, type: 'flora:signedEvent', id: event.data.id, data: signed }, '*');
      } catch (err) {
        window.postMessage({ channel: CHANNEL, type: 'flora:error', id: event.data.id, error: String(err) }, '*');
      }
    }
  });
});
