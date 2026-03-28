<p align="center">
  <img src="public/logo.png" alt="Flora" width="128">
</p>

# Flora

Record your screen, share anywhere. Stored on [Blossom](https://github.com/hzrd149/blossom), publish to [Nostr](https://nostr.com/).

Flora is a Chrome extension for fast, frictionless screen recording on decentralized infrastructure. Think Loom, but your recordings live on Blossom servers you choose, and you can publish them as Nostr notes — no accounts, no corporate servers, no lock-in.

## Tech Stack

- **Framework**: [WXT](https://wxt.dev) (Vite-based Chrome extension toolkit), TypeScript, Chrome MV3
- **Encoding**: [mediabunny](https://github.com/nicenathapong/mediabunny) (WebCodecs MP4 muxing — AV1 / VP9 / H.264)
- **Storage**: [Blossom](https://github.com/hzrd149/blossom) (blossom-client-sdk)
- **Protocol**: [Nostr](https://nostr.com/) (nostr-tools), NIP-07 signing, NIP-17 private DMs, NIP-44 encryption, NIP-59 gift wrap

## Features

- **Screen recording** with system audio, microphone, and optional webcam overlay
- **Webcam bubble** — resizable (S/M/L), free-drag anywhere on screen, persisted position and size
- **WebCodecs encoding** — hardware-accelerated MP4 output (AV1 > VP9 > H.264 fallback)
- **Three sharing modes** — Public (Blossom + Nostr note), Unlisted (Blossom link only), or Private (encrypted, NIP-17)
- **Private sharing** — AES-256-GCM encrypted video, delivered via NIP-17 Kind 15 gift-wrapped messages to selected recipients
- **Recipient picker** — search your Nostr follow list, paste npub or NIP-05, see DM relay status per recipient
- **Blossom upload** — recordings stored on decentralized file servers
- **Nostr publishing** — optionally publish a note with your recording link to configured relays
- **NIP-07 signing** — uses your existing Nostr signer extension (Nos2x, Alby, etc.)
- **Identity management** — enter your npub in settings; auto-populated after first signing
- **Recording library** — browse, replay, re-upload, and manage past recordings locally
- **Configurable destinations** — choose your own Blossom servers and Nostr relays
- **Dark mode only** — designed to look good, not generic

## Install

Flora is not yet on the Chrome Web Store. Two ways to install:

### Download a release (easiest)

1. Download the latest `.zip` from [Releases](https://github.com/shawnyeager/flora-extension/releases)
2. Unzip it
3. Open `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked**
6. Select the unzipped folder

### Build from source

```bash
git clone https://github.com/shawnyeager/flora-extension.git
cd flora-extension
npm install
npm run build
```

Then load `.output/chrome-mv3/` as an unpacked extension (same steps 3-6 above).

## Usage

1. **Click the Flora icon** in your Chrome toolbar to open the popup
2. **Hit Record** — choose a tab, window, or entire screen
3. **Record** — pause, resume, toggle mic/webcam from the popup controls
4. **Stop** — Flora encodes your recording into an MP4
5. **Review** — preview your recording, choose sharing mode (Public / Unlisted / Private)
6. **Share** — Public uploads to Blossom and publishes a Nostr note; Unlisted uploads without a note; Private encrypts and sends directly to selected recipients
7. **Done** — copy the Blossom link (Public/Unlisted) or see delivery confirmation (Private)

### Settings

Open the settings page from the popup menu to configure:

- **Blossom servers** — where recordings are uploaded (defaults: `blossom.primal.net`, `blossom.nostr.build`)
- **Nostr relays** — where notes are published (defaults: `nos.lol`, `relay.damus.io`, `relay.primal.net`, `relay.nostr.band`)
- **Publish to Nostr** — toggle automatic note publishing after upload
- **Default sharing mode** — set whether new recordings default to Public, Unlisted, or Private

### NIP-07 Signing

Flora uses the [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) standard to sign Nostr events. You need a NIP-07 signer extension installed (like [Nos2x](https://github.com/nicehash/nos2x) or [Alby](https://getalby.com/)) and an active web tab for signing to work. Your pubkey is auto-saved after the first successful signing, or you can enter it manually as an npub in Settings.

### Private Sharing

Private mode encrypts your recording with AES-256-GCM before uploading to Blossom. The encrypted blob is meaningless without the decryption key, which is delivered only to your chosen recipients via [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) encrypted direct messages (Kind 15 file messages, gift-wrapped per [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md)).

Recipients view the video in any Nostr client that supports NIP-17 file messages (0xchat, Amethyst).

Requirements for Private mode:
- A NIP-07 signer with NIP-44 encryption support (nos2x works)
- Recipients need Nostr identities (npub) and ideally published DM relay lists (Kind 10050)

## Development

### Prerequisites

- Node.js (18+)
- npm
- Chrome

### Dev server

```bash
npm run dev
```

This starts WXT in watch mode with hot reload. Load `.output/chrome-mv3/` as an unpacked extension in Chrome. Changes to source files will rebuild automatically — reload the extension from `chrome://extensions` to pick them up.

### Firefox

```bash
npm run dev:firefox     # dev server
npm run build:firefox   # production build
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (Chrome) |
| `npm run dev:firefox` | Start dev server (Firefox) |
| `npm run build` | Production build (Chrome) |
| `npm run build:firefox` | Production build (Firefox) |
| `npm run zip` | Create .zip for Chrome Web Store |
| `npm run zip:firefox` | Create .zip for Firefox Add-ons |
| `npm run compile` | TypeScript type check |

### Releasing

Version lives in `package.json`. Everything else reads from it automatically.

```bash
npm version patch          # bump 0.2.0 → 0.2.1 (auto-commits + tags)
git push origin master --tags   # CI builds zip + creates GitHub release
```

Use `npm version minor` for new features (0.2.0) or `npm version major` for breaking changes (1.0.0).

## Architecture

Flora runs across four Chrome extension contexts:

```
┌─────────────────────────────────────────────────────────┐
│  Chrome Browser                                         │
│                                                         │
│  ┌─────────────┐  messages  ┌────────────────────────┐  │
│  │   Popup     │◄──────────►│   Service Worker       │  │
│  │   Review    │            │   (background.ts)      │  │
│  │   Settings  │            │                        │  │
│  │   Library   │            │   - State machine      │  │
│  └─────────────┘            │   - Message routing    │  │
│                             │   - NIP-07 proxying    │  │
│  ┌─────────────┐            │   - Icon badge         │  │
│  │  Content    │◄──────────►│                        │  │
│  │  Script     │            └───────────┬────────────┘  │
│  │             │                        │               │
│  │  - Webcam   │            ┌───────────▼────────────┐  │
│  │    overlay   │            │   Offscreen Document   │  │
│  │  - NIP-07   │            │   (offscreen/main.ts)  │  │
│  │    bridge   │            │                        │  │
│  └─────────────┘            │   - Screen capture     │  │
│                             │   - Audio mixing       │  │
│                             │   - WebCodecs encode   │  │
│                             │   - Blossom upload     │  │
│                             │   - AES-GCM encryption │  │
│                             │   - NIP-59 gift wrap   │  │
│                             │   - Nostr publish      │  │
│                             │   - IndexedDB storage  │  │
│                             └────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Service Worker (`background.ts`)

Central orchestrator. Manages the recording state machine, routes messages between contexts, proxies NIP-07 signing calls to the active tab, and controls the extension icon badge.

### Offscreen Document (`offscreen/main.ts`)

Handles all media work: captures screen via `getDisplayMedia()`, acquires microphone, mixes audio streams, encodes video/audio with WebCodecs, muxes MP4, stores recordings in IndexedDB, uploads to Blossom, and publishes Nostr events.

### Content Script (`overlay.content/`)

Injected into web pages. Renders a draggable webcam overlay (Shadow DOM), bridges NIP-07 signer access from the page's main world to the extension.

### UI Pages

| Page | Path | Purpose |
|------|------|---------|
| Popup | `popup/` | Start/stop recording, timer, quick actions |
| Review | `review/` | Post-recording preview, upload confirmation |
| Recordings | `recordings/` | Recording library with thumbnails |
| Settings | `settings/` | Blossom servers, Nostr relays, preferences |
| Permissions | `permissions/` | Camera/microphone permission flow |

### State Machine

```
idle → initializing → awaiting_media → countdown → recording
  → finalizing → preview → uploading → publishing → complete
                                    ↘ complete  (unlisted/private skip publishing)
```

States from `finalizing` onward are protected — the UI blocks dismissal to prevent data loss during encoding, upload, or publishing. For private shares, `uploading` covers encryption, Blossom upload, and gift-wrap delivery in one pass.

### Key Dependencies

| Package | Purpose |
|---------|---------|
| [`wxt`](https://wxt.dev) | Chrome extension framework (Vite-based, MV3) |
| [`mediabunny`](https://github.com/nicenathapong/mediabunny) | WebCodecs video/audio encoding and MP4 muxing |
| [`blossom-client-sdk`](https://github.com/hzrd149/blossom-client-sdk) | Blossom file server upload/retrieval |
| [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools) | Nostr event creation, signing, relay management, NIP-44/NIP-59 |

## Project Structure

```
flora-extension/
├── entrypoints/
│   ├── background.ts           # Service worker (state machine, message hub)
│   ├── nostr-bridge.ts         # Main-world NIP-07 bridge script
│   ├── popup/                  # Extension popup UI
│   ├── review/                 # Post-recording review & upload
│   ├── offscreen/              # Media capture, encoding, upload
│   ├── recordings/             # Recording library
│   ├── settings/               # User configuration
│   ├── permissions/            # Permission request flow
│   ├── controls/               # Recording controls toolbar
│   └── overlay.content/        # Content script (webcam, NIP-07)
├── utils/
│   ├── messages.ts             # Typed message definitions
│   ├── state.ts                # State machine types
│   ├── settings.ts             # Settings read/write
│   ├── icons.ts                # SVG icon strings
│   └── tokens.css              # Shared design tokens
├── public/icon/                # Extension icons (16, 32, 48, 128)
├── docs/                       # Brainstorms and implementation plans
├── wxt.config.ts               # WXT/manifest configuration
├── package.json
└── tsconfig.json
```

## License

MIT
