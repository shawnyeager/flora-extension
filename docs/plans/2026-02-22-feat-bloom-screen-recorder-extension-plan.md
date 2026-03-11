---
title: "feat: Build Bloom - Decentralized Screen Recording Chrome Extension"
type: feat
status: active
date: 2026-02-22
---

# Build Bloom - Decentralized Screen Recording Chrome Extension

## Overview

Bloom is a Chrome/Chromium extension that replicates Loom's core screen recording experience (screen + webcam overlay + mic) using decentralized Nostr + Blossom infrastructure. It encodes in real-time via WebCodecs (AV1-first with VP9/H.264 fallback), muxes to MP4 with Mediabunny, uploads to user-configured Blossom servers, and publishes a Nostr note with the video link.

**Brainstorm reference:** `docs/brainstorms/2026-02-22-bloom-brainstorm.md`

## Problem Statement

Loom is centralized — recordings live on Loom's servers, require a Loom account, and are subject to their pricing/policies. There is no decentralized alternative that provides the same frictionless "record and share" experience. The Nostr ecosystem has Blossom for blob storage but no screen recording tool that leverages it.

## Proposed Solution

A Chrome MV3 extension with four execution contexts (popup, service worker, offscreen document, content script) that handles capture, encoding, upload, and publishing entirely client-side. No server-side processing required.

## Technical Approach

### Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────────┐
│   Popup      │────▶│  Service Worker   │────▶│   Offscreen Document    │
│              │     │                  │     │                         │
│ - Start/Stop │     │ - State machine  │     │ - getDisplayMedia()     │
│ - Settings   │     │ - Message router │     │ - getUserMedia() (mic)  │
│ - Upload     │     │ - chrome.storage │     │ - getUserMedia() (cam)  │
│   progress   │     │ - Offscreen      │     │ - Canvas compositing    │
│              │     │   lifecycle      │     │ - WebCodecs encoding    │
└─────────────┘     └──────────────────┘     │ - Mediabunny muxing     │
                           │                  │ - Web Audio mixing      │
                           ▼                  │ - Blossom upload        │
                    ┌──────────────────┐     │ - IndexedDB persistence │
                    │  Content Script   │     └─────────────────────────┘
                    │                  │
                    │ - Webcam bubble  │
                    │   preview        │
                    │ - Recording      │
                    │   controls       │
                    │ - NIP-07 bridge  │
                    │   (main-world    │
                    │    script inject)│
                    │ - Shadow DOM     │
                    └──────────────────┘
```

### Extension State Machine

```
                    ┌───────┐
                    │ IDLE  │◀──────────────────────────┐
                    └───┬───┘                            │
                        │ user clicks "Start"            │
                        ▼                                │
               ┌────────────────┐                        │
               │ INITIALIZING   │──── error ────▶ IDLE   │
               │                │                        │
               │ - create       │                        │
               │   offscreen doc│                        │
               │ - inject       │                        │
               │   content script                        │
               │ - probe codecs │                        │
               └───────┬────────┘                        │
                       │ all ready                       │
                       ▼                                 │
               ┌────────────────┐                        │
               │ AWAITING_MEDIA │──── denied ───▶ IDLE   │
               │                │                        │
               │ - getDisplay   │                        │
               │   Media()      │                        │
               │ - getUserMedia │                        │
               │   (cam + mic)  │                        │
               └───────┬────────┘                        │
                       │ streams acquired                │
                       ▼                                 │
               ┌────────────────┐                        │
               │ COUNTDOWN      │──── cancel ───▶ IDLE   │
               │ (3, 2, 1...)   │                        │
               └───────┬────────┘                        │
                       │                                 │
                       ▼                                 │
               ┌────────────────┐                        │
               │ RECORDING      │                        │
               │                │                        │
               │ - encoding     │                        │
               │   frames       │                        │
               │ - muxing to MP4│                        │
               └───────┬────────┘                        │
                       │ user clicks Stop /              │
                       │ stream ends /                   │
                       │ error                           │
                       ▼                                 │
               ┌────────────────┐                        │
               │ FINALIZING     │                        │
               │                │                        │
               │ - flush encoder│                        │
               │ - finalize mux │                        │
               │ - persist to   │                        │
               │   IndexedDB    │                        │
               └───────┬────────┘                        │
                       │                                 │
                       ▼                                 │
               ┌────────────────┐                        │
               │ UPLOADING      │──── fail ────▶ ERROR   │
               │                │                   │    │
               │ - pre-flight   │                   │    │
               │ - upload primary                   │    │
               │ - mirror       │                   │    │
               └───────┬────────┘              retry │    │
                       │                        ▼    │    │
                       │                   ┌────────┐│    │
                       │                   │ ERROR  ││    │
                       │                   │        ├┘    │
                       │                   │ retry /│     │
                       │                   │ save   │     │
                       │                   │ local  │     │
                       ▼                   └────────┘     │
               ┌────────────────┐                        │
               │ PUBLISHING     │                        │
               │                │                        │
               │ - sign kind 1  │                        │
               │   via NIP-07   │                        │
               │ - publish to   │                        │
               │   relays       │                        │
               └───────┬────────┘                        │
                       │                                 │
                       ▼                                 │
               ┌────────────────┐                        │
               │ COMPLETE       │────────────────────────┘
               │                │  user dismisses
               │ - show link    │
               │ - copy to      │
               │   clipboard    │
               └────────────────┘
```

State is persisted in `chrome.storage.session` so the popup can recover it after being closed/reopened, and the service worker can recover after restart.

### Implementation Phases

#### Phase 1: Project Scaffolding

Set up the build system and extension skeleton using WXT.

**Build tool decision:** After researching CRXJS (broken Shadow DOM CSS, no first-class offscreen support), vite-plugin-crx-mv3 (abandoned, 199 downloads/mo), and manual Vite config (3 config files, no HMR), we chose **WXT** (wxt.dev) — actively maintained, 648k downloads/mo, Vite-based, built-in Shadow DOM CSUI, framework-agnostic.

**Tasks:**
- [x] Initialize WXT project with vanilla TypeScript (`pnpm dlx wxt@latest init`)
- [x] Configure `wxt.config.ts` with manifest permissions
- [x] Create entry points following WXT file-based conventions:
  - `entrypoints/popup/index.html` + `entrypoints/popup/main.ts`
  - `entrypoints/background.ts`
  - `entrypoints/offscreen/index.html` + `entrypoints/offscreen/main.ts`
  - `entrypoints/overlay.content/index.ts`
  - `entrypoints/nostr-bridge.ts` (unlisted script for main-world NIP-07 bridge)
- [x] Set up message passing types (`utils/messages.ts`)
- [x] Define state machine types and transitions (`utils/state.ts`)
- [x] Install dependencies: `mediabunny`, `blossom-client-sdk`, `nostr-tools`
- [x] Configure `.gitignore`, `tsconfig.json`
- [x] Create minimal popup UI (just a "Start Recording" button) to verify the extension loads
- [x] Add placeholder icons to `public/icon/` (16, 32, 48, 128)

**WXT config (`wxt.config.ts`):**

```typescript
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Bloom',
    description: 'Decentralized screen recording powered by Nostr + Blossom',
    version: '0.1.0',
    permissions: [
      'offscreen',
      'activeTab',
      'storage',
    ],
    host_permissions: ['<all_urls>'],
    web_accessible_resources: [{
      resources: ['nostr-bridge.js'],
      matches: ['<all_urls>'],
    }],
  },
});
```

**Project structure:**

```
bloom/
  entrypoints/
    popup/
      index.html
      main.ts
      style.css
    background.ts
    offscreen/
      index.html
      main.ts
    overlay.content/
      index.ts
      style.css
    nostr-bridge.ts
  utils/
    messages.ts
    state.ts
  public/
    icon/
      16.png
      32.png
      48.png
      128.png
  package.json
  tsconfig.json
  wxt.config.ts
```

**Key WXT conventions:**
- File names in `entrypoints/` determine manifest entries automatically (no hand-written manifest.json)
- WXT provides `browser` as auto-imported cross-browser API wrapper (use `browser.*` not `chrome.*`)
- Auto-imports: `defineBackground`, `defineContentScript`, `createShadowRootUi`, `injectScript`, `browser`
- `cssInjectionMode: 'ui'` on content scripts injects CSS into Shadow DOM (not page head)
- Offscreen documents are unlisted HTML pages — WXT builds them but you manage lifecycle in background.ts

**Note on permissions:** We use `<all_urls>` host_permissions because the content script must inject on any page for the webcam overlay and NIP-07 bridge. `activeTab` alone would require user gesture per page, which breaks the recording flow when the user navigates mid-recording. This will need justification for Chrome Web Store review.

**Acceptance criteria:**
- [ ] Extension loads in Chrome with no errors
- [ ] Popup opens and shows a button
- [ ] Service worker registers and logs to console
- [ ] Content script injects on web pages
- [ ] All four contexts can exchange messages via `chrome.runtime`

---

#### Phase 2: Screen Capture + WebCodecs Encoding Pipeline

Build the core recording pipeline in the offscreen document.

**Implementation note:** Mediabunny's `MediaStreamVideoTrackSource` and `MediaStreamAudioTrackSource` handle the entire capture-encode-mux pipeline from raw MediaStream tracks. This eliminated the need for separate codec probe, encoder, frame loop, and audio processing modules — the library handles all of this internally.

**Tasks:**
- [x] Implement offscreen document lifecycle management in service worker
  - Create on recording start via `browser.offscreen.createDocument()`, close on reset
- [x] Implement `getDisplayMedia()` in offscreen document
  - Set `contentHint: "detail"` on the video track for screen content coding
- [x] Implement codec detection and fallback chain
  - Uses Mediabunny's `getFirstEncodableVideoCodec(['av1', 'vp9', 'avc'])`
  - Uses `getFirstEncodableAudioCodec(['aac', 'opus'])` for audio
- [x] Implement video encoding (via `MediaStreamVideoTrackSource`)
  - AV1: 2 Mbps, VP9: 2.5 Mbps, H.264: 4 Mbps, all with `latencyMode: 'realtime'`
- [x] Implement audio encoding (via `MediaStreamAudioTrackSource`)
  - AAC or Opus at 128 kbps
  - System audio + mic mixed via AudioContext when both available
- [x] Implement Mediabunny muxing pipeline
  - `Output` with `Mp4OutputFormat({ fastStart: 'in-memory' })` + `BufferTarget`
- [x] Implement start/stop recording flow
  - Start: getDisplayMedia -> getUserMedia -> create sources -> create output -> start
  - Stop: close sources -> finalize output -> get buffer from target
  - Handle stream ending (user stops sharing via browser UI)
- [x] Persist the finalized MP4 to IndexedDB for crash recovery / retry
  - SHA-256 hash as key, stores buffer + metadata

**Acceptance criteria:**
- [ ] Can record a screen (full screen, window, or tab) with microphone audio
- [ ] Produces a valid MP4 file that plays in Chrome, VLC, and QuickTime
- [ ] AV1 codec is used when available, falls back to VP9/H.264
- [ ] File size is ~1.5-3 Mbps for AV1 at 1080p30
- [ ] Recording can be stopped and the file is available immediately

---

#### Phase 3: Webcam Compositing

Add webcam overlay composited into the screen recording.

**Tasks:**
- [x] Implement webcam capture in offscreen document
  - `getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' } })`
  - Separate stream from screen capture
- [x] ~~Implement canvas compositing in offscreen document~~
  - **Architecture change:** Webcam compositing moved to content script overlay. Tab capture naturally includes the overlay, so the offscreen document just records the raw screen via `MediaStreamVideoTrackSource`. This eliminates double-overlay issues and simplifies the pipeline.
- [x] Handle webcam toggle (on/off during recording)
  - When off, draw screen frame only (no webcam)
  - State communicated via TOGGLE_WEBCAM message through service worker
- [x] Handle webcam position
  - Default: bottom-left circle
  - For v1, position is fixed (configurable position is out of scope)
- [x] Handle frame synchronization
  - Screen and webcam rendered via HTMLVideoElement, drawn at screen's frame rate
  - requestAnimationFrame loop throttled to ~30fps
  - Always draws most recent webcam frame onto current screen frame

**Acceptance criteria:**
- [ ] Recorded video shows webcam circle overlay in bottom-left
- [ ] Webcam can be toggled on/off mid-recording
- [ ] No visible lag or desync between screen and webcam
- [ ] Compositing doesn't cause frame drops at 30fps

---

#### Phase 4: Content Script UI

Build the recording overlay UI injected into web pages.

**Tasks:**
- [x] Create Shadow DOM container for style isolation
  - WXT `createShadowRootUi` with `position: 'overlay'`, `cssInjectionMode: 'ui'`
- [x] Implement webcam preview bubble
  - Separate `getUserMedia` call from content script context
  - Circular shape, bottom-left, fixed position
  - Click to toggle webcam on/off
  - Pre-acquired during `awaiting_media` state to hide camera spinup latency
- [x] Implement recording controls bar
  - Timer display (MM:SS), stop button, mic mute/unmute toggle
  - Pause/resume and minimize deferred to v2
- [ ] Implement countdown overlay (3, 2, 1) before recording starts (deferred to v2)
- [x] Implement restricted page fallback
  - `chrome.action.setBadgeText()` shows "REC" on extension icon
  - Popup shows stop button when recording
- [x] Handle page navigation during recording
  - Content script re-injects on new page (manifest `content_scripts`)
  - Restores UI state from `chrome.storage.local`

**Note on webcam preview approach:** Calling `getUserMedia()` from a content script shows the page's origin in the permission prompt and may be blocked by `Permissions-Policy` headers. For v1, accept this limitation. If the webcam preview fails in the content script, show a static "camera" icon instead — the actual webcam compositing in the offscreen document is unaffected.

**Acceptance criteria:**
- [ ] Shadow DOM overlay renders without interfering with page styles
- [ ] Timer counts up during recording
- [ ] Stop button ends recording and triggers finalization
- [ ] Mic mute/unmute works
- [ ] Webcam preview shows (when permissions allow)
- [ ] Controls survive page navigation within the same tab
- [ ] Extension icon shows "REC" badge on restricted pages

---

#### Phase 5: NIP-07 Integration

Implement the Nostr signer bridge for authentication.

**Tasks:**
- [x] Create main-world bridge script (`entrypoints/nostr-bridge.ts`)
  - Injected into page's main world via WXT `injectScript()` + `web_accessible_resources`
  - Accesses `window.nostr` (NIP-07 signer)
  - Communicates with isolated-world content script via `window.postMessage`
  - Uses a unique, unguessable channel ID per session to prevent spoofing
  - Request/response matched by unique `id` field per request
- [x] Create isolated-world NIP-07 proxy in content script (`entrypoints/overlay.content/index.ts`)
  - Injects bridge script via `injectScript('/nostr-bridge.js')`
  - Listens for bridge ready message and captures channel ID
  - Handles NIP07_SIGN and NIP07_GET_PUBKEY messages from background
  - Routes signing requests through bridge via `window.postMessage`
  - 60s timeout for signing requests (user may need to approve in signer)
- [x] Create NIP07Signer adapter (inline in `entrypoints/offscreen/main.ts`)
  - `createSigner()` returns `Signer` compatible with `blossom-client-sdk`
  - Routes via `browser.runtime.sendMessage` → background → content script → bridge
- [ ] Handle CSP restrictions (deferred to v2)
- [ ] Handle NIP-07 not available (deferred to v2 — errors propagate via UPLOAD_ERROR)
- [ ] Handle signing during upload on restricted pages (deferred to v2)

**Security considerations:**
- Never pass private keys — NIP-07 handles signing internally
- Validate all data from `postMessage` (check channel ID, check origin)
- Scope auth events tightly: specific server URL, specific file hash, short expiration (60s)
- Log signing requests for user transparency

**Acceptance criteria:**
- [ ] Can detect NIP-07 signer presence
- [ ] Can get public key from NIP-07 signer
- [ ] Can sign kind 24242 auth events for Blossom
- [ ] Can sign kind 1 note events for publishing
- [ ] Works on pages with standard CSP
- [ ] Graceful degradation when NIP-07 is unavailable
- [ ] Signing requests are scoped (server, hash, expiration)

---

#### Phase 6: Blossom Upload

Implement file upload to Blossom servers.

**Tasks:**
- [x] Integrate `blossom-client-sdk` in offscreen document (`entrypoints/offscreen/main.ts`)
  - Upload runs in offscreen document (has network access)
  - NIP-07 signing proxied: offscreen → background → content script → nostr-bridge → NIP-07
  - `BlossomClient` with `auth: true` handles Blossom auth event creation + signing
- [ ] Implement pre-flight check flow (deferred to v2)
- [x] Implement primary upload
  - `BlossomClient.uploadBlob()` handles PUT /upload with auth header
  - Returns `BlobDescriptor` with url, sha256, size
- [ ] Implement multi-server mirroring (deferred to v2 — uploads to primary server only)
- [x] Implement upload progress reporting
  - Offscreen sends UPLOAD_PROGRESS → background relays to popup + content scripts
  - Popup shows "Uploading to <server>... XX%"
- [ ] Implement retry logic (deferred to v2 — manual retry via popup button)
- [x] Implement IndexedDB persistence
  - Recordings stored with hash, data, size, duration, timestamp, uploaded flag
  - Popup offers retry button on upload failure

**Acceptance criteria:**
- [ ] MP4 uploads to blossom.band (or configured server) successfully
- [ ] SHA-256 hash matches what the server reports
- [ ] Mirroring to additional servers works
- [ ] Upload progress is visible in the popup
- [ ] Failed uploads are persisted and retryable
- [ ] Pre-flight check prevents wasted uploads to servers that will reject

---

#### Phase 7: Nostr Publishing

Publish a note with the video link after upload.

**Tasks:**
- [ ] Integrate `nostr-tools` SimplePool (`src/shared/nostr-client.ts`)
  - Create pool with `enablePing: true`, `enableReconnect: true`
  - Connect to user-configured relays (defaults: `wss://relay.damus.io`, `wss://nos.lol`)
- [ ] Construct kind 1 note with video metadata
  ```typescript
  const note: EventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content: `${userCaption}\n\n${blossomUrl}`,
    tags: [
      ['r', blossomUrl],                    // reference URL
      ['imeta',
        `url ${blossomUrl}`,
        `x ${sha256Hash}`,
        `m video/mp4`,
        `dim ${width}x${height}`,
        `size ${fileSize}`,
        `alt Screen recording`
      ],
    ],
  };
  ```
- [x] Sign via NIP-07 and publish to relays
  - `await Promise.any(pool.publish(relays, signedEvent))`
  - At least one relay acceptance = success
  - Implemented in `entrypoints/offscreen/main.ts` `publishNote()`
- [ ] Publish kind 10063 server list (BUD-03) (deferred to v2)
- [x] Generate shareable links
  - Blossom direct URL shown in popup on complete state
  - Copy Link button copies URL to clipboard
- [ ] Add optional caption input (deferred to v2)
- [x] Offer "skip publishing" option
  - `publishToNostr` setting in `utils/settings.ts` (default: true)
  - When false, skips `publishNote()` and goes straight to complete

**Acceptance criteria:**
- [ ] Kind 1 note publishes to at least one relay
- [ ] Note includes correct imeta tags (URL, hash, dimensions, size)
- [ ] Kind 10063 server list is published when servers change
- [ ] Shareable link is generated and copyable
- [ ] User can skip Nostr publishing and just get the Blossom URL

---

#### Phase 8: Settings & First-Time Setup

Build configuration UI and onboarding flow.

**Tasks:**
- [ ] Create settings page (`src/settings/index.html` + `src/settings/main.ts`)
  - Accessible from popup menu
  - Sections:
    1. **Nostr Identity**: Shows connected pubkey (npub), signer status
    2. **Blossom Servers**: Primary server URL + mirror server list (add/remove/reorder)
    3. **Nostr Relays**: Relay list (add/remove), with defaults pre-populated
    4. **Recording**: Preferred codec (auto/AV1/VP9/H.264), resolution, framerate
    5. **About**: Version, links
- [ ] Store settings in `chrome.storage.sync` (syncs across devices)
  ```typescript
  interface BloomSettings {
    blossomServers: string[];          // first is primary
    nostrRelays: string[];
    preferredCodec: 'auto' | 'av1' | 'vp9' | 'h264';
    resolution: '720p' | '1080p' | 'native';
    framerate: 15 | 30;
    publishToNostr: boolean;           // default: true
    webcamEnabled: boolean;            // default: true
    webcamShape: 'circle';             // v1: circle only
  }
  ```
- [ ] Implement first-run detection
  - Check `chrome.storage.sync` for `setupComplete` flag
  - If not set, show onboarding flow instead of normal popup
- [ ] Create onboarding flow (in popup or dedicated tab)
  1. **Welcome**: "Bloom records your screen and shares via Nostr + Blossom"
  2. **NIP-07 Check**: Detect signer. If missing, show install links for nos2x/Alby. Block until detected.
  3. **Connect**: Call `getPublicKey()`, show npub. "Connected as npub1..."
  4. **Blossom Server**: Pre-fill `blossom.band`, let user change. Validate connectivity.
  5. **Done**: Set `setupComplete`, show main popup UI
- [ ] Implement Blossom server validation
  - On add/change: `HEAD /upload` to check server is reachable
  - Show server limits (from pre-flight response headers) if available
- [ ] Implement recording size estimator
  - During recording, show estimated file size based on elapsed time and bitrate
  - Compare against primary server's size limit (if known from pre-flight)
  - Warn when approaching limit (e.g., "~30 seconds remaining before server limit")

**Acceptance criteria:**
- [ ] First-run onboarding guides user through setup
- [ ] NIP-07 signer is detected and public key displayed
- [ ] Blossom servers are configurable and validated
- [ ] Relay list is configurable
- [ ] Settings persist across sessions and devices (chrome.storage.sync)
- [ ] Recording size estimate is shown during recording

---

#### Phase 9: Standalone Viewer Page

Build a static site for viewing shared recordings.

**Tasks:**
- [ ] Create static site project (`viewer/`)
  - Single HTML page with embedded JS/CSS (no build step, or minimal Vite build)
  - Hosted on GitHub Pages at `bloom-viewer.example.com` (or similar)
- [ ] Implement URL structure
  - `https://bloom-viewer.example.com/v/<sha256>?s=<server1>&s=<server2>`
  - Parse hash and server hints from URL
- [ ] Implement video player
  - HTML5 `<video>` element with native controls
  - Fetch video from first available server: try each `?s=` server hint
  - If all hints fail, attempt to resolve via kind 10063 server list from Nostr relays
- [ ] Add metadata display
  - Show: duration, resolution, file size, recording date
  - Show author npub (if note ID is in URL params)
- [ ] Add Open Graph meta tags for social sharing
  - `og:type`: video.other
  - `og:video`: direct MP4 URL
  - `og:title`: "Bloom Recording"
  - `og:description`: caption text (if available)
  - Note: OG tags must be in the initial HTML, so we need server-side rendering or a meta tag injection service. For v1, use static fallback OG tags.
- [ ] Add "Record with Bloom" link to Chrome Web Store

**Acceptance criteria:**
- [ ] Viewer loads and plays video from Blossom URL
- [ ] Falls back to alternative servers if primary is down
- [ ] Clean, minimal player UI
- [ ] Works on mobile browsers
- [ ] Social sharing shows a basic preview (title + description)

---

## Alternative Approaches Considered

### MediaRecorder + Post-Processing (Rejected)
Simpler capture pipeline but requires FFmpeg.wasm transcoding after recording. Adds ~10x encoding time, double quality loss from re-encoding, and large FFmpeg.wasm bundle. Does not achieve "state of the art compression" goal.

### Hybrid MediaRecorder + WebCodecs (Rejected)
Running two encoding pipelines simultaneously doubles CPU usage. Added complexity of managing two parallel recording streams outweighs the safety net benefit.

### NIP-46 Remote Signer (Deferred to v2)
More flexible but significantly more complex. NIP-07 browser extensions are the most common signer type in the Nostr ecosystem and sufficient for v1.

### NDK-Blossom Instead of blossom-client-sdk (Rejected)
NDK-Blossom requires the full NDK dependency. Since we only need targeted Blossom operations and already use nostr-tools for relay communication, `blossom-client-sdk` keeps the dependency graph lighter.

## Acceptance Criteria

### Functional Requirements
- [ ] Record screen + webcam + microphone in Chrome
- [ ] Encode to AV1/MP4 (or VP9/H.264 fallback) in real-time
- [ ] Upload to user-configured Blossom server(s) with mirroring
- [ ] Authenticate via NIP-07 (kind 24242 auth events)
- [ ] Publish Nostr kind 1 note with video link
- [ ] Generate shareable link (Blossom URL + viewer page)
- [ ] First-time onboarding flow
- [ ] Configurable Blossom servers and Nostr relays

### Non-Functional Requirements
- [ ] MP4 file size: ~1.5-3 Mbps for AV1 at 1080p30 (30-50% smaller than H.264)
- [ ] Recording starts within 3 seconds of user clicking "Start"
- [ ] File ready immediately when recording stops (real-time encoding)
- [ ] Extension popup loads in < 200ms
- [ ] Works on Chrome 120+ (WebCodecs, offscreen API)

### Quality Gates
- [ ] All TypeScript compiles with strict mode
- [ ] Produced MP4 files play in Chrome, Safari, Firefox, VLC
- [ ] Extension passes Chrome Web Store review
- [ ] No console errors during normal operation

## Dependencies & Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| `mediabunny` | ^1.34 | MP4 muxing from WebCodecs output |
| `blossom-client-sdk` | ^4.1 | Blossom server upload, auth, mirroring |
| `nostr-tools` | ^2.23 | Nostr event construction, relay communication, NIP-07 types |

**Dev dependencies:**
| Dependency | Purpose |
|---|---|
| `wxt` | Chrome extension framework (Vite-based, includes build system) |
| `typescript` | Type checking |
| `@types/chrome` | Chrome extension API types (used with `extensionApi: 'chrome'`) |

**External requirements:**
- User must have a NIP-07 browser extension (nos2x, Alby, etc.)
- User must have access to a Blossom server (default: blossom.band)
- Chrome/Chromium browser (120+)

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `getDisplayMedia()` blocked from offscreen doc (no transient activation) | Medium | High | Fallback: open small extension tab for capture picker |
| Page CSP blocks NIP-07 bridge script injection | Medium | Medium | Fallback: `chrome.scripting.executeScript` with `world: 'MAIN'`, or popup-based signing |
| AV1 software encoding too slow for real-time on low-end machines | Medium | Medium | Fallback to VP9/H.264 automatically; frame dropping strategy for AV1 |
| Blossom server 20 MiB limit too small for most recordings | High | Medium | Show live size estimate + server limit; prompt user before recording exceeds limit |
| Chrome Web Store rejects `<all_urls>` permission | Low | High | Justify in review submission; content script overlay requires injection on any page |
| `MediaStreamTrack` not transferable between content script and offscreen doc | High | Low | Use separate `getUserMedia()` calls; accept double permission prompt for webcam |
| Service worker dies mid-recording | Medium | Low | Offscreen document operates independently; state in `chrome.storage.session` |

## Future Considerations (v2+)

- Video trimming/editing before upload
- Drawing/annotation tools during recording
- NIP-46 remote signer support
- Encrypted/private video recordings (NIP-44)
- View analytics (NIP-based event counting)
- Comments/reactions on recordings
- Desktop app version (Tauri)
- Configurable webcam position (draggable in both preview and recording)
- Custom viewer page domains
- Recording history / gallery in popup

## References & Research

### Internal References
- Brainstorm: `docs/brainstorms/2026-02-22-bloom-brainstorm.md`

### External References
- [Blossom Protocol Spec](https://github.com/hzrd149/blossom) — BUD-01 through BUD-10
- [NIP-B7 Blossom Media](https://nips.nostr.com/B7) — Nostr + Blossom integration
- [NIP-07](https://nips.nostr.com/7) — Browser extension signer interface
- [NIP-94](https://nips.nostr.com/94) — File metadata tags
- [Mediabunny Docs](https://mediabunny.dev/) — MP4 muxing API
- [blossom-client-sdk](https://github.com/hzrd149/blossom-client-sdk) — Blossom client library
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) — Nostr protocol library
- [Chrome WebCodecs](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs) — Encoding API
- [Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) — Background DOM context
- [Chrome Screen Capture](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture) — Extension recording guide
- [Screenity](https://github.com/alyssaxuu/screenity) — Open-source screen recording extension reference
- [Chrome Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) — Isolated worlds documentation
