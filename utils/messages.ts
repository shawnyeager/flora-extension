import type { ExtensionState } from './state';

export const MessageType = {
  // Popup -> Background
  START_RECORDING: 'start_recording',
  STOP_RECORDING: 'stop_recording',
  GET_STATE: 'get_state',
  RESET_STATE: 'reset_state',

  // Background -> Offscreen
  START_CAPTURE: 'start_capture',
  STOP_CAPTURE: 'stop_capture',

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

  // Offscreen -> Background (upload progress)
  UPLOAD_PROGRESS: 'upload_progress',
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

export interface GetStateMessage extends BaseMessage {
  type: typeof MessageType.GET_STATE;
}

export interface ResetStateMessage extends BaseMessage {
  type: typeof MessageType.RESET_STATE;
}

export interface StartCaptureMessage extends BaseMessage {
  type: typeof MessageType.START_CAPTURE;
  target: 'offscreen';
}

export interface StopCaptureMessage extends BaseMessage {
  type: typeof MessageType.STOP_CAPTURE;
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

export type Message =
  | StartRecordingMessage
  | StopRecordingMessage
  | GetStateMessage
  | ResetStateMessage
  | StartCaptureMessage
  | StopCaptureMessage
  | CaptureReadyMessage
  | CaptureErrorMessage
  | RecordingCompleteMessage
  | StateChangedMessage
  | GetRecordingMessage
  | ToggleWebcamMessage
  | ToggleMicMessage
  | UploadProgressMessage;
