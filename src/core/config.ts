export const VERSION = "1.0.8";

export interface GlotConfig {
  endpointUrl: string;
  modelId: string;
  apiKey: string;
  lang: string;
  dataDir: string;
  glossaryDir: string;
  promptsDir: string;
  coreDir: string;
  translationsDir: string;
  maxStrings: number;
  batchSize: number;
  concurrency: number;
  requestTimeout: number; // seconds; 0 disables timeout
  batchDelay: number; // seconds; 0 disables
  debug: boolean;
}

export const DEFAULT_MAX_STRINGS = 200;
export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_CONCURRENCY = 1;
export const DEFAULT_REQUEST_TIMEOUT = 120;
export const DEFAULT_BATCH_DELAY = 0;

export const CORE_PROJECTS = [
  "wp/dev/{slug}/default",
  "wp/dev/admin/{slug}/default",
  "wp/dev/admin/network/{slug}/default",
];
