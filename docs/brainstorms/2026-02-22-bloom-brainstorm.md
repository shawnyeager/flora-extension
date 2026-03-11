# Bloom - Decentralized Screen Recording Chrome Extension

**Date**: 2026-02-22
**Status**: Brainstorm

## What We're Building

Bloom is a Chrome/Chromium extension that clones Loom's core screen recording experience but replaces the centralized backend with Nostr + Blossom infrastructure. Users record their screen with webcam overlay and microphone, the extension encodes with state-of-the-art compression (AV1-first), and uploads to user-configured Blossom servers for decentralized storage.

### Core User Flow

1. User clicks the Bloom extension icon
2. Chooses capture mode (screen + webcam + mic)
3. Chrome shows the native screen/window/tab picker
4. Recording starts with webcam bubble overlay and controls on-screen (encoding happens in real-time via WebCodecs)
5. User stops recording — MP4 file is ready immediately
6. Uploads to primary Blossom server, optionally mirrors to additional servers
7. Publishes a Nostr note (event) with the video URL
8. Returns a shareable link (both Blossom direct URL and a standalone viewer page)

### Target Users

- Nostr community members wanting decentralized video sharing
- Teams using Nostr for async communication
- Content creators publishing tutorials/demos on Nostr
- Anyone wanting Loom-like functionality without vendor lock-in

## Why This Approach

### Architecture: WebCodecs Pipeline

We chose a WebCodecs-based encoding pipeline over MediaRecorder or post-processing approaches because:

1. **Best compression**: AV1 via WebCodecs with screen content coding tools yields 30-50% smaller files than H.264, and 25%+ better than standard AV1 for screen content specifically
2. **Full control**: Frame-by-frame encoding lets us optimize for screen recording characteristics (variable framerate, sharp text, flat colors)
3. **MP4 output**: Using Mediabunny muxer produces universally playable MP4 files
4. **Graceful degradation**: Falls back to VP9 when AV1 hardware/software encoding isn't available

### Why Blossom over traditional hosting

- Content-addressed storage (SHA-256 hashes) - files are universally addressable
- No accounts, no sessions - Nostr key-based auth (kind 24242 events)
- Decentralized - mirror across multiple servers for redundancy
- Censorship-resistant - no single point of control
- Interoperable - any Blossom-compatible client can access the content

## Key Decisions

### 1. Nostr Authentication: NIP-07 Browser Extension Only

Users must have a Nostr signer extension installed (nos2x, Alby, etc.). The extension never touches private keys. Auth flow:

- Content script calls `window.nostr.getPublicKey()` to identify the user (NIP-07 signers inject into the page DOM, which only content scripts can access — not the popup, offscreen document, or service worker)
- For uploads, content script constructs a kind 24242 event and calls `window.nostr.signEvent()` to sign it
- Signed event is passed to the offscreen document via `chrome.runtime` messaging
- Offscreen document sends it as `Authorization: Nostr <base64>` header on Blossom API calls

### 2. Video Encoding: AV1-First with Fallback Chain

```
AV1 (WebCodecs) -> VP9 (WebCodecs) -> H.264 (WebCodecs)
```

- On startup, probe `VideoEncoder.isConfigSupported()` for each codec
- Use the best available codec
- Enable `contentHint: "detail"` on the MediaStreamTrack for AV1 screen content coding tools
- Real-time encoding during recording (frames encoded as captured, file ready instantly when recording stops)
- Target settings: 1080p, 30fps, ~1.5-3 Mbps for AV1

### 3. Container Format: MP4 via Mediabunny

- Mediabunny is the successor to mp4-muxer/webm-muxer (both deprecated)
- Pure TypeScript, zero dependencies, tree-shakable
- Produces MP4 files with proper seeking metadata
- Audio codec: AAC (universal MP4 compatibility)

### 4. Capture Architecture: Offscreen Document + Content Script

```
[Popup]           -- Start recording, settings, device selection
    |
[Service Worker]  -- Coordinates messaging, state management
    |
    +--> [Offscreen Document]  -- getDisplayMedia() (reason: DISPLAY_MEDIA),
    |                             getUserMedia() for mic (reason: USER_MEDIA),
    |                             WebCodecs encoding, Mediabunny muxing,
    |                             canvas compositing (webcam into screen recording),
    |                             audio mixing via Web Audio API,
    |                             Blossom upload (receives signed auth from content script)
    |
    +--> [Content Script]      -- Floating webcam bubble preview (own getUserMedia stream),
                                  recording controls overlay, countdown timer, stop button,
                                  NIP-07 signing proxy (only context with window.nostr access)
```

Note: The webcam appears in two places — the content script shows a live preview bubble to the user, while the offscreen document composites webcam frames into the recorded video via canvas. These may share a stream via `MediaStreamTrack.clone()` or use separate `getUserMedia()` calls.

### 5. Storage: Multiple Blossom Servers with Mirroring

- User configures a primary Blossom server in settings (default: blossom.band)
- Can add additional mirror servers
- Upload flow:
  1. Hash the MP4 file (SHA-256)
  2. Pre-flight check (`HEAD /upload`) on primary server
  3. Upload to primary (`PUT /upload` with kind 24242 auth)
  4. Mirror to additional servers (`PUT /mirror` on each)
- Store user's server list as a kind 10063 event per BUD-03

### 6. Sharing: Nostr Note + Standalone Viewer

After upload:
1. Publish a Nostr kind 1 note with the Blossom URL embedded to user-configured relays (with sensible defaults like wss://relay.damus.io, wss://nos.lol)
2. Include NIP-94 file metadata tags (dimensions, duration, size, codec)
3. Generate a shareable link to a standalone viewer page
4. Viewer page fetches the video from Blossom and plays it with a clean UI
5. Non-Nostr users can watch via the direct Blossom URL or viewer page

### 7. Manifest V3 Permissions

```json
{
  "permissions": [
    "tabCapture",
    "offscreen",
    "activeTab",
    "storage"
  ],
  "host_permissions": ["<all_urls>"]
}
```

## Technical Constraints

### Platform-Specific Limitations

- **System audio**: Only available on Windows when sharing entire screen. Mac/Linux get tab audio only.
- **AV1 hardware encoding**: ~8% availability on Windows, 0% on Mac/Linux. Software encoding works but is slower.
- **One offscreen document**: Chrome allows only one per extension - all media processing shares it.
- **Service worker lifecycle**: 5-minute idle timeout. Recording logic must live in the offscreen document, not the service worker.

### Blossom Server Considerations

- No protocol-level file size limits, but servers set their own (blossom.band free tier: 20 MiB)
- **20 MiB is tight for video**: At AV1 1.5 Mbps, that's ~1.5 minutes of recording. Users on free tiers of public servers will need either a paid tier, a self-hosted server, or very short recordings.
- Use `HEAD /upload` pre-flight to check limits before uploading and show remaining capacity to the user
- Free tiers typically support .mp4 format

### Dependencies

- **Mediabunny**: MP4 muxing (TypeScript, zero-dep)
- **blossom-client-sdk**: Blossom upload/auth (JavaScript)
- **nostr-tools** (or similar): Nostr event construction, NIP-07 integration

## Resolved Questions

1. **Viewer page hosting**: Static site hosted on GitHub Pages (or similar). Takes a Blossom hash as URL param, renders a clean video player. Nostr notes also published for in-client viewing.

2. **Recording size limits**: Auto-detect from the Blossom server using BUD-06 pre-flight (`HEAD /upload`). Show the user their server's actual limits. No artificial restrictions.

3. **Encoding timing**: Real-time encoding during recording. Frames are encoded via WebCodecs as they're captured. File is ready instantly when recording stops. Screen content is low-motion and forgiving of occasional frame drops under CPU pressure.

## Out of Scope (for v1)

- Video editing/trimming before upload
- Drawing/annotation tools during recording
- NIP-46 remote signer support
- Encryption/private videos
- Analytics/view counts
- Comments/reactions on videos
- Desktop app version
