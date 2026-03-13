import type { ExtensionState } from './state';

export const MessageType = {
  // Popup/Content -> Background
  START_RECORDING: 'start_recording',
  STOP_RECORDING: 'stop_recording',
  PAUSE_RECORDING: 'pause_recording',
  RESUME_RECORDING: 'resume_recording',
  GET_STATE: 'get_state',
  RESET_STATE: 'reset_state',

  // Background -> Offscreen
  START_CAPTURE: 'start_capture',
  STOP_CAPTURE: 'stop_capture',
  PAUSE_CAPTURE: 'pause_capture',
  RESUME_CAPTURE: 'resume_capture',

  // Offscreen -> Background
  CAPTURE_READY: 'capture_ready',
  CAPTURE_ERROR: 'capture_error',
  RECORDING_COMPLETE: 'recording_complete',

  // Background -> All (broadcast)
  STATE_CHANGED: 'state_changed',

  // Content Script -> Background (NIP-07 proxy)
  SIGN_EVENT: 'sign_event',
  GET_PUBLIC_KEY: 'get_public_key',

  // Popup/Content -> Offscreen (via background)
  GET_RECORDING: 'get_recording',
  TOGGLE_WEBCAM: 'toggle_webcam',
  TOGGLE_MIC: 'toggle_mic',

  // Upload flow
  START_UPLOAD: 'start_upload',
  UPLOAD_PROGRESS: 'upload_progress',
  UPLOAD_COMPLETE: 'upload_complete',
  UPLOAD_ERROR: 'upload_error',

  // Nostr publishing
  PUBLISH_NOTE: 'publish_note',
  PUBLISH_COMPLETE: 'publish_complete',
  PUBLISH_ERROR: 'publish_error',

  // NIP-07 signing proxy
  NIP07_SIGN: 'nip07_sign',
  NIP07_GET_PUBKEY: 'nip07_get_pubkey',

  // Result retrieval
  GET_RESULT: 'get_result',
  GET_ERROR: 'get_error',

  // NIP-07 direct probe (via scripting.executeScript, no postMessage)
  NIP07_PROBE: 'nip07_probe',

  // Confirmation flow
  GET_CONFIRM_DATA: 'get_confirm_data',
  CONFIRM_UPLOAD: 'confirm_upload',
  BACK_TO_PREVIEW: 'back_to_preview',

  // Recording library
  LIST_RECORDINGS: 'list_recordings',
  DELETE_RECORDING: 'delete_recording',
  MARK_UPLOADED: 'mark_uploaded',
  GET_RECORDING_BY_HASH: 'get_recording_by_hash',
  UPLOAD_FROM_LIBRARY: 'upload_from_library',
  GENERATE_THUMBNAIL: 'generate_thumbnail',
  DELETE_RECORDINGS: 'delete_recordings',

  // Recording controls state (popup <-> background)
  GET_RECORDING_STATE: 'get_recording_state',

  // Navigation
  OPEN_SETTINGS: 'open_settings',

  // Overlay tab-following
  OVERLAY_SHOW: 'overlay_show',
  OVERLAY_HIDE: 'overlay_hide',
  OVERLAY_CORNER_CHANGED: 'overlay_corner_changed',

  // Tab capture switching
  SWITCH_TAB_CAPTURE: 'switch_tab_capture',
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

/** Message target — used to route messages to the correct context */
export type MessageTarget = 'offscreen' | 'background' | 'popup' | 'content';

export interface BaseMessage {
  type: MessageTypeValue;
  target?: MessageTarget;
}

export interface StartRecordingMessage extends BaseMessage {
  type: typeof MessageType.START_RECORDING;
}

export interface StopRecordingMessage extends BaseMessage {
  type: typeof MessageType.STOP_RECORDING;
}

export interface PauseRecordingMessage extends BaseMessage {
  type: typeof MessageType.PAUSE_RECORDING;
}

export interface ResumeRecordingMessage extends BaseMessage {
  type: typeof MessageType.RESUME_RECORDING;
}

export interface GetStateMessage extends BaseMessage {
  type: typeof MessageType.GET_STATE;
}

export interface ResetStateMessage extends BaseMessage {
  type: typeof MessageType.RESET_STATE;
}

export interface StartCaptureMessage extends BaseMessage {
  type: typeof MessageType.START_CAPTURE;
  target: 'offscreen';
  streamId: string;
}

export interface StopCaptureMessage extends BaseMessage {
  type: typeof MessageType.STOP_CAPTURE;
  target: 'offscreen';
}

export interface PauseCaptureMessage extends BaseMessage {
  type: typeof MessageType.PAUSE_CAPTURE;
  target: 'offscreen';
}

export interface ResumeCaptureMessage extends BaseMessage {
  type: typeof MessageType.RESUME_CAPTURE;
  target: 'offscreen';
}

export interface CaptureReadyMessage extends BaseMessage {
  type: typeof MessageType.CAPTURE_READY;
  codec: string;
}

export interface CaptureErrorMessage extends BaseMessage {
  type: typeof MessageType.CAPTURE_ERROR;
  error: string;
}

export interface RecordingCompleteMessage extends BaseMessage {
  type: typeof MessageType.RECORDING_COMPLETE;
  /** Size in bytes of the finalized MP4 */
  size: number;
  /** Duration in seconds */
  duration: number;
}

export interface StateChangedMessage extends BaseMessage {
  type: typeof MessageType.STATE_CHANGED;
  state: ExtensionState;
}

export interface GetRecordingMessage extends BaseMessage {
  type: typeof MessageType.GET_RECORDING;
  target: 'offscreen';
}

export interface ToggleWebcamMessage extends BaseMessage {
  type: typeof MessageType.TOGGLE_WEBCAM;
  enabled: boolean;
}

export interface ToggleMicMessage extends BaseMessage {
  type: typeof MessageType.TOGGLE_MIC;
  muted: boolean;
}

export interface UploadProgressMessage extends BaseMessage {
  type: typeof MessageType.UPLOAD_PROGRESS;
  bytesUploaded: number;
  totalBytes: number;
  serverName: string;
}

export interface StartUploadMessage extends BaseMessage {
  type: typeof MessageType.START_UPLOAD;
  target: 'offscreen';
  serverOverride?: string;
  publishToNostr?: boolean;
}

export interface UploadCompleteMessage extends BaseMessage {
  type: typeof MessageType.UPLOAD_COMPLETE;
  url: string;
  sha256: string;
  size: number;
}

export interface UploadErrorMessage extends BaseMessage {
  type: typeof MessageType.UPLOAD_ERROR;
  error: string;
}

export interface PublishNoteMessage extends BaseMessage {
  type: typeof MessageType.PUBLISH_NOTE;
  target: 'offscreen';
  blossomUrl: string;
  sha256: string;
  size: number;
  noteContent?: string;
}

export interface PublishCompleteMessage extends BaseMessage {
  type: typeof MessageType.PUBLISH_COMPLETE;
  noteId: string;
  blossomUrl: string;
}

export interface PublishErrorMessage extends BaseMessage {
  type: typeof MessageType.PUBLISH_ERROR;
  error: string;
}

export interface Nip07SignMessage extends BaseMessage {
  type: typeof MessageType.NIP07_SIGN;
  event: { kind: number; content: string; tags: string[][]; created_at: number };
}

export interface Nip07GetPubkeyMessage extends BaseMessage {
  type: typeof MessageType.NIP07_GET_PUBKEY;
}

export interface GetResultMessage extends BaseMessage {
  type: typeof MessageType.GET_RESULT;
}

export interface GetErrorMessage extends BaseMessage {
  type: typeof MessageType.GET_ERROR;
}

export interface GetConfirmDataMessage extends BaseMessage {
  type: typeof MessageType.GET_CONFIRM_DATA;
}

export interface ConfirmUploadMessage extends BaseMessage {
  type: typeof MessageType.CONFIRM_UPLOAD;
  serverOverride?: string;
  publishToNostr: boolean;
  noteContent?: string;
}

export interface BackToPreviewMessage extends BaseMessage {
  type: typeof MessageType.BACK_TO_PREVIEW;
}

export interface Nip07ProbeMessage extends BaseMessage {
  type: typeof MessageType.NIP07_PROBE;
  tabId?: number;
}

// Recording library
export interface RecordingMeta {
  hash: string;
  size: number;
  duration: number;
  timestamp: number;
  uploaded: boolean;
  blossomUrl?: string;
  noteId?: string;
  thumbnail?: string;
}

export interface ListRecordingsMessage extends BaseMessage {
  type: typeof MessageType.LIST_RECORDINGS;
}

export interface DeleteRecordingMessage extends BaseMessage {
  type: typeof MessageType.DELETE_RECORDING;
  hash: string;
}

export interface MarkUploadedMessage extends BaseMessage {
  type: typeof MessageType.MARK_UPLOADED;
  hash: string;
  blossomUrl: string;
}

export interface GetRecordingByHashMessage extends BaseMessage {
  type: typeof MessageType.GET_RECORDING_BY_HASH;
  hash: string;
}

export interface UploadFromLibraryMessage extends BaseMessage {
  type: typeof MessageType.UPLOAD_FROM_LIBRARY;
  hash: string;
  serverOverride?: string;
  publishToNostr: boolean;
  noteContent?: string;
}

export interface GenerateThumbnailMessage extends BaseMessage {
  type: typeof MessageType.GENERATE_THUMBNAIL;
  hash: string;
}

export interface DeleteRecordingsMessage extends BaseMessage {
  type: typeof MessageType.DELETE_RECORDINGS;
  hashes: string[];
}

export interface GetRecordingStateMessage extends BaseMessage {
  type: typeof MessageType.GET_RECORDING_STATE;
}

export interface OpenSettingsMessage extends BaseMessage {
  type: typeof MessageType.OPEN_SETTINGS;
}

export interface OverlayShowMessage extends BaseMessage {
  type: typeof MessageType.OVERLAY_SHOW;
  webcamOn: boolean;
  corner: string;
}

export interface OverlayHideMessage extends BaseMessage {
  type: typeof MessageType.OVERLAY_HIDE;
}

export interface OverlayCornerChangedMessage extends BaseMessage {
  type: typeof MessageType.OVERLAY_CORNER_CHANGED;
  corner: string;
}

export interface SwitchTabCaptureMessage extends BaseMessage {
  type: typeof MessageType.SWITCH_TAB_CAPTURE;
  target: 'offscreen';
  streamId: string;
}

export interface RecordingControlsState {
  paused: boolean;
  micMuted: boolean;
  webcamOn: boolean;
  recordingStartedAt: number; // Date.now() when recording began
  pausedAccumulated: number;  // ms spent paused so far
}

export type Message =
  | StartRecordingMessage
  | StopRecordingMessage
  | PauseRecordingMessage
  | ResumeRecordingMessage
  | GetStateMessage
  | ResetStateMessage
  | StartCaptureMessage
  | StopCaptureMessage
  | PauseCaptureMessage
  | ResumeCaptureMessage
  | CaptureReadyMessage
  | CaptureErrorMessage
  | RecordingCompleteMessage
  | StateChangedMessage
  | GetRecordingMessage
  | ToggleWebcamMessage
  | ToggleMicMessage
  | UploadProgressMessage
  | StartUploadMessage
  | UploadCompleteMessage
  | UploadErrorMessage
  | PublishNoteMessage
  | PublishCompleteMessage
  | PublishErrorMessage
  | Nip07SignMessage
  | Nip07GetPubkeyMessage
  | GetResultMessage
  | GetErrorMessage
  | GetConfirmDataMessage
  | ConfirmUploadMessage
  | BackToPreviewMessage
  | Nip07ProbeMessage
  | ListRecordingsMessage
  | DeleteRecordingMessage
  | MarkUploadedMessage
  | GetRecordingByHashMessage
  | UploadFromLibraryMessage
  | GenerateThumbnailMessage
  | DeleteRecordingsMessage
  | GetRecordingStateMessage
  | OpenSettingsMessage
  | OverlayShowMessage
  | OverlayHideMessage
  | OverlayCornerChangedMessage
  | SwitchTabCaptureMessage;
