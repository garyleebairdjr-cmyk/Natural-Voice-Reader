export type DownloadOptInState = {
  signedIn: boolean;
  saveToDrive: boolean;
  introSeen: boolean;
};

/** Upload only when the user is signed in and they turned the toggle on. */
export function shouldUploadToDrive(state: DownloadOptInState): boolean {
  return Boolean(state.signedIn && state.saveToDrive);
}

/** Explain the Drive download option the first time a signed-in user downloads. */
export function shouldExplainDriveDownloads(state: DownloadOptInState): boolean {
  return Boolean(state.signedIn && !state.introSeen);
}
