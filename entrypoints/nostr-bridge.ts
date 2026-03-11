export default defineUnlistedScript(() => {
  console.log('[nostr-bridge] main-world script loaded');

  // This runs in the page's main world — access to window.nostr (NIP-07)
  // Communication with the content script happens via CustomEvents

  const CHANNEL = '__bloom_nip07_' + crypto.randomUUID();

  // Signal readiness to the content script
  window.dispatchEvent(
    new CustomEvent('bloom:bridge:ready', { detail: { channel: CHANNEL } }),
  );

  // Listen for signing requests from the content script
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL) return;

    const nostr = (window as any).nostr;

    if (event.data.type === 'bloom:getPublicKey') {
      if (!nostr) {
        window.postMessage(
          { channel: CHANNEL, type: 'bloom:error', error: 'NIP-07 signer not found' },
          '*',
        );
        return;
      }
      try {
        const pubkey = await nostr.getPublicKey();
        window.postMessage(
          { channel: CHANNEL, type: 'bloom:publicKey', data: pubkey },
          '*',
        );
      } catch (err) {
        window.postMessage(
          { channel: CHANNEL, type: 'bloom:error', error: String(err) },
          '*',
        );
      }
    }

    if (event.data.type === 'bloom:signEvent') {
      if (!nostr) {
        window.postMessage(
          { channel: CHANNEL, type: 'bloom:error', error: 'NIP-07 signer not found' },
          '*',
        );
        return;
      }
      try {
        const signed = await nostr.signEvent(event.data.event);
        window.postMessage(
          { channel: CHANNEL, type: 'bloom:signedEvent', data: signed },
          '*',
        );
      } catch (err) {
        window.postMessage(
          { channel: CHANNEL, type: 'bloom:error', error: String(err) },
          '*',
        );
      }
    }
  });
});
