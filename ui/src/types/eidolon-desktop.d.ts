export {};

type DesktopRuntimeServiceStatus =
  | "healthy"
  | "unavailable"
  | "unconfigured"
  | "error";

interface DesktopRuntimeService {
  id: string;
  label: string;
  url: string;
  required: boolean;
  status: DesktopRuntimeServiceStatus;
  latencyMs: number | null;
  statusCode?: number;
  error: string | null;
}

interface DesktopOpenJarvisPreset {
  id: string;
  configured: boolean;
}

interface DesktopRuntimeStatus {
  desktop: true;
  appUrl: string;
  generatedAt: string;
  services: DesktopRuntimeService[];
  openJarvis: {
    configured: boolean;
    presets: DesktopOpenJarvisPreset[];
  };
}

interface DesktopOpenJarvisLaunchResult {
  preset: string;
  pid: number | null;
  launchedAt: string;
}

declare global {
  interface Window {
    eidolonDesktop?: {
      getRuntimeStatus: () => Promise<DesktopRuntimeStatus>;
      launchOpenJarvisPreset: (
        preset: string,
      ) => Promise<DesktopOpenJarvisLaunchResult>;
      onRuntimeStatusRefresh: (callback: () => void) => () => void;
    };
  }
}
