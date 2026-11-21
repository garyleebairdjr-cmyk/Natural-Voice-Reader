import { createServerFn } from "@tanstack/react-start";

export type GooglePublicConfig = {
  enabled: boolean;
  clientId: string;
  apiKey: string;
};

export function readGooglePublicConfig(env: NodeJS.ProcessEnv = process.env): GooglePublicConfig {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() || env.VITE_GOOGLE_CLIENT_ID?.trim() || "";
  const apiKey = env.GOOGLE_API_KEY?.trim() || env.VITE_GOOGLE_API_KEY?.trim() || "";
  return { enabled: Boolean(clientId && apiKey), clientId, apiKey };
}

export const getGooglePublicConfig = createServerFn({ method: "GET" }).handler(async (): Promise<GooglePublicConfig> => {
  return readGooglePublicConfig();
});
