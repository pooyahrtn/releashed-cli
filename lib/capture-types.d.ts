/** Caller-supplied provenance. These types do not replace runtime input validation. */
export interface CaptureMetadataInput {
  goal?: string | null;
  policy?: string | null;
  continues?: string | null;
  precondition?: string | null;
  identityLabel?: string | null;
}

export interface CaptureRoots {
  runsRoot: string;
  mapsRoot: string;
}

/** The screenshot fields read by selection; the full trace has other fields. */
export interface ScreenshotObservation {
  screenshot_path?: string | null;
  screenshot_sha256?: string | null;
}

export interface SelectionEvent {
  event_id?: string | null;
  timestamp?: string | null;
  before?: ScreenshotObservation | null;
  after?: ScreenshotObservation | null;
}

/** A selected original observation, not proof that the requested goal was reached. */
export interface SelectedScreenshot {
  screenshot_path: string;
  event_id: string | null;
  captured_at: string | null;
  screenshot_sha256: string | null;
}

/** Only the sealed-manifest fields consumed by screenshot selection. */
export interface ScreenshotManifest {
  files: Array<{ path: string; sha256: string }>;
}
