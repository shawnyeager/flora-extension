// Chrome's proprietary MediaStreamTrackProcessor (shipped Chrome 94+)
// Not in lib.dom.d.ts because TypeScript requires 2+ browser engines.

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}

declare class MediaStreamTrackProcessor {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<VideoFrame>;
}

interface MediaStreamTrackGeneratorInit {
  kind: string;
}

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: MediaStreamTrackGeneratorInit);
  readonly writable: WritableStream<VideoFrame>;
}
