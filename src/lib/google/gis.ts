/** Shared typings for Google Identity Services and Picker. */
export type GisTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export type GisTokenClient = {
  requestAccessToken: (opts?: { prompt?: string }) => void;
};

export type PickerDoc = { id?: string; name?: string; mimeType?: string };
export type PickerData = { action?: string; docs?: PickerDoc[] };

type PickerBuilder = {
  addView: (view: unknown) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setCallback: (cb: (data: PickerData) => void) => PickerBuilder;
  setOrigin?: (origin: string) => PickerBuilder;
  setTitle?: (title: string) => PickerBuilder;
  build: () => { setVisible: (show: boolean) => void };
};

type DocsView = {
  setIncludeFolders?: (on: boolean) => DocsView;
  setSelectFolderEnabled?: (on: boolean) => DocsView;
  setMimeTypes?: (types: string) => DocsView;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: GisTokenResponse) => void;
            error_callback?: (error: { type?: string; message?: string }) => void;
          }) => GisTokenClient;
          revoke: (token: string, done?: () => void) => void;
        };
      };
      picker?: {
        PickerBuilder: new () => PickerBuilder;
        DocsView: new (viewId?: unknown) => DocsView;
        Action?: { PICKED: string; CANCEL: string };
        ViewId?: { DOCS: unknown };
      };
    };
    gapi?: { load: (name: string, cb: () => void) => void };
  }
}

export {};
