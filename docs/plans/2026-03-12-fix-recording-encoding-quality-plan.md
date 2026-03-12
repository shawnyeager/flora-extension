---
title: "fix: Recording encoding quality"
type: fix
status: completed
date: 2026-03-12
---

# fix: Recording Encoding Quality

## Overview

Recording quality is poor — blurry text, compression artifacts on screen content. The root cause is conservative encoding defaults: low bitrates (2-4 Mbps), no resolution-aware scaling, and missing encoder hints. This plan brings quality to Loom parity while keeping file sizes reasonable.

## Problem Statement

Current encoding defaults in `entrypoints/offscreen/main.ts`:

| Setting | Current | Problem |
|---------|---------|---------|
| AV1 bitrate | 2 Mbps | Text/code is blurry — screen content needs 2x this |
| VP9 bitrate | 2.5 Mbps | Same — ringing artifacts on sharp edges |
| AVC bitrate | 4 Mbps | Below Loom's ~6-8 Mbps for 1080p screen |
| `latencyMode` | `'realtime'` | Forced by mediabunny's `MediaStreamVideoTrackSource` — **cannot change** |
| `bitrateMode` | unset (default VBR) | Fine, but should be explicit |
| `keyFrameInterval` | unset (default 5s) | Acceptable, 3s would improve seeking |
| `hardwareAcceleration` | unset | Missing — defaults to software encoding |
| Resolution | uncapped | 4K displays try to encode at native res with 1080p-level bitrate |
| Audio bitrate | 128 kbps | Adequate for voice, low for system audio with music |
| `frameRate` in source opts | unset | Defaults to track settings, but should be explicit 30fps |

### Key constraint

`MediaStreamVideoTrackSource` **forces `latencyMode: 'realtime'` internally** (mediabunny `media-source.ts:1114-1117`), regardless of what we pass. Switching to `'quality'` mode (which enables B-frames and lookahead for ~15-25% better compression) would require refactoring to `VideoSampleSource` — out of scope for this fix. We work within the `'realtime'` constraint and compensate with higher bitrates.

## Proposed Solution

### Use `QUALITY_HIGH` presets instead of manual bitrates

mediabunny has built-in `Quality` presets that auto-scale bitrate based on actual capture resolution and codec efficiency:

```typescript
import { QUALITY_HIGH } from 'mediabunny';

// QUALITY_HIGH at 1080p resolves to:
//   AVC:  ~6.0 Mbps
//   VP9:  ~3.6 Mbps
//   AV1:  ~2.4 Mbps

// At 1440p it auto-scales to:
//   AVC:  ~10.5 Mbps
//   VP9:  ~6.3 Mbps
//   AV1:  ~4.2 Mbps
```

However, these presets are tuned for camera footage. Screen content with text needs ~1.5-2x more bitrate than camera content at the same resolution. So we'll use manual bitrates that are resolution-scaled, targeting slightly above `QUALITY_HIGH` equivalent.

### Resolution-scaled bitrates

```typescript
// Base bitrates at 1080p (1920x1080 = 2,073,600 pixels)
const BASE_BITRATES: Record<string, number> = {
  av1: 4_000_000,   // 4 Mbps (was 2 Mbps)
  vp9: 5_000_000,   // 5 Mbps (was 2.5 Mbps)
  avc: 8_000_000,   // 8 Mbps (was 4 Mbps)
};

const BASE_PIXELS = 1920 * 1080;

// Scale proportionally to actual capture resolution
const settings = videoTrack.getSettings();
const capturePixels = (settings.width ?? 1920) * (settings.height ?? 1080);
const pixelRatio = capturePixels / BASE_PIXELS;
// Sub-linear scaling — 4K doesn't need 4x the bitrate
const bitrate = Math.round(BASE_BITRATES[videoCodec] * Math.pow(pixelRatio, 0.75));
```

The `^0.75` exponent means 4K (4x pixels) gets ~3x the bitrate, not 4x. This matches how compression efficiency improves with larger frame sizes.

### Bitrate comparison: before vs after

| Resolution | Codec | Before | After | File size (30s) |
|-----------|-------|--------|-------|-----------------|
| 1080p | AV1 | 2.0 Mbps | 4.0 Mbps | ~15 MB |
| 1080p | VP9 | 2.5 Mbps | 5.0 Mbps | ~19 MB |
| 1080p | AVC | 4.0 Mbps | 8.0 Mbps | ~30 MB |
| 1440p | AV1 | 2.0 Mbps | 6.1 Mbps | ~23 MB |
| 1440p | VP9 | 2.5 Mbps | 7.6 Mbps | ~29 MB |
| 4K | AV1 | 2.0 Mbps | 10.7 Mbps | ~40 MB |

These are reasonable — Loom's Chrome extension produces files in the 15-40 MB range for 30s recordings.

### Additional encoder settings

```typescript
videoSource = new MediaStreamVideoTrackSource(
  videoTrack as MediaStreamVideoTrack,
  {
    codec: videoCodec,
    bitrate,                              // resolution-scaled (see above)
    bitrateMode: 'variable',              // explicit — allocate bits where needed
    keyFrameInterval: 3,                  // seconds — better seeking than 5s default
    hardwareAcceleration: 'prefer-hardware', // use GPU when available
    contentHint: 'detail',                // prioritize sharpness over motion smoothness
    sizeChangeBehavior: 'contain',        // keep — handles mid-recording resolution changes
  },
  { frameRate: 30 },                      // explicit source sampling rate
);
```

### Audio: bump to 192 kbps

```typescript
audioSource = new MediaStreamAudioTrackSource(
  mixedTrack as MediaStreamAudioTrack,
  { codec: audioCodec, bitrate: 192_000 },  // was 128_000
);
```

192 kbps AAC is the max that mediabunny clamps to, and it noticeably improves system audio quality (music, video playback in recordings).

### Codec detection: use actual resolution

Currently `getFirstEncodableVideoCodec` tests at a hardcoded `{ width: 1920, height: 1080 }`. This should use the actual capture resolution so the codec support check is accurate for the real encoding workload.

```typescript
const settings = videoTrack.getSettings();
const testWidth = settings.width ?? 1920;
const testHeight = settings.height ?? 1080;

const videoCodec = await getFirstEncodableVideoCodec(
  ['av1', 'vp9', 'avc'] as VideoCodec[],
  { width: testWidth, height: testHeight, bitrate: BASE_BITRATES.avc },
);
```

## Files

| File | Change |
|------|--------|
| `entrypoints/offscreen/main.ts:52-55` | Codec detection: use actual capture resolution |
| `entrypoints/offscreen/main.ts:66-77` | Video source: resolution-scaled bitrate, add `bitrateMode`, `keyFrameInterval`, `hardwareAcceleration`, explicit `frameRate` option |
| `entrypoints/offscreen/main.ts:94-97` | Audio source: bump to 192 kbps |
| `entrypoints/offscreen/main.ts:111` | `addVideoTrack` frameRate already 30 — no change needed |

## Edge Cases

- **AV1 hardware encoding unavailable**: `getFirstEncodableVideoCodec` already falls back to VP9/AVC. The `hardwareAcceleration: 'prefer-hardware'` hint is advisory — if no hardware encoder exists, Chrome falls back to software.
- **4K displays**: Bitrate scales via `pixelRatio^0.75`, producing ~10 Mbps for AV1 at 4K. This is reasonable for quality but means larger files. The sub-linear exponent prevents runaway file sizes.
- **VP9 + VBR + SVC Chrome bug**: We don't use SVC (`scalabilityMode` is not set), so this bug doesn't apply.
- **AVC odd dimensions**: `sizeChangeBehavior: 'contain'` handles this — mediabunny pads to even dimensions.
- **Memory with BufferTarget**: Higher bitrates mean larger buffers. A 60s recording at 4K AV1 (~10 Mbps) is ~75 MB in memory. This is fine for typical screen recordings (<5 min). Longer recordings may want `StreamTarget` in the future.
- **`latencyMode: 'realtime'` forced**: Cannot change without refactoring to `VideoSampleSource`. Accept this constraint — the bitrate increase compensates.
- **Codec detection at real resolution**: If a codec can't encode at the captured resolution (e.g., AV1 software at 4K), fallback to VP9/AVC happens naturally.

## Acceptance Criteria

- [ ] Text in 1080p screen recordings is sharp and readable (no blur/ringing on code)
- [ ] 1440p recordings look noticeably better than before
- [ ] File sizes for 30s recording at 1080p: AV1 ~15 MB, VP9 ~19 MB, AVC ~30 MB (within 30%)
- [ ] AV1/VP9/AVC all still work (codec fallback chain intact)
- [ ] Audio is clear at 192 kbps (system audio + mic)
- [ ] No encoding errors or dropped frames in console
- [ ] Download still produces valid MP4

## Implementation Order

1. Scale bitrates and add encoder settings (single change to `startCapture()`)
2. Bump audio bitrate
3. Fix codec detection to use actual resolution
4. Build, test with screen recording of a code editor

## References

- `entrypoints/offscreen/main.ts` — all encoding happens here
- mediabunny docs: https://mediabunny.dev/
- mediabunny source: `node_modules/mediabunny/src/encode.ts` (Quality, VideoEncodingConfig)
- mediabunny source: `node_modules/mediabunny/src/media-source.ts:1114` (forced realtime latency)
- WebCodecs best practices: https://developer.chrome.com/docs/web-platform/best-practices/webcodecs
- AV1 Screen Content Coding: https://visionular.ai/av1-screen-content-coding/
