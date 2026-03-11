import type { ExtensionState } from './state';

export const MessageType = {
  // Popup -> Background
  START_RECORDING: 'start_recording',
  STOP_RECORDING: 'stop_recording',
  GET_STATE: 'get_state',

  // Background -> Offscreen
  START_CAPTURE: 'start_capture',
  STOP_CAPTURE: 'stop_capture',

  // Background -> All (broadcast)
  STATE_CHANGED: 'state_changed',

  // Content Script -> Background (NIP-07 proxy)
  SIGN_EVENT: 'sign_event',
  GET_PUBLIC_KEY: 'get_public_key',

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

export interface StartCaptureMessage extends BaseMessage {
  type: typeof MessageType.START_CAPTURE;
  target: 'offscreen';
}

export interface StopCaptureMessage extends BaseMessage {
  type: typeof MessageType.STOP_CAPTURE;
  target: 'offscreen';
}

export interface StateChangedMessage extends BaseMessage {
  type: typeof MessageType.STATE_CHANGED;
  state: ExtensionState;
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
  | StartCaptureMessage
  | StopCaptureMessage
  | StateChangedMessage
  | UploadProgressMessage;
