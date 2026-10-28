import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const DEV = process.env.DEV === "1";
export const PORT = Number(process.env.PORT || 3020);
export const DATA_DIR = process.env.DATA_DIR || "./data";
export const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
export const MAIL_FROM = process.env.MAIL_FROM || "BenBot <benbot@benbot.si>";

if (!process.env.WORKER_TOKEN && !DEV) {
  console.error("FATAL: WORKER_TOKEN is not set. Set it, or run with DEV=1 for local development.");
  process.exit(1);
}
/** The homeserver worker and the approval CLI both use it; nothing else can change state outside a user's own chats. */
export const WORKER_TOKEN = process.env.WORKER_TOKEN || "dev-token";

export const DB_PATH = join(DATA_DIR, "videoinator.db");
/** Reference clips the planner shows, and finished videos. */
export const MEDIA_DIR = join(DATA_DIR, "media");
mkdirSync(MEDIA_DIR, { recursive: true });

export const DEFAULT_CREDITS = 5;
/** A claimed planner turn that hasn't been answered by then goes back on the queue. */
export const TURN_LEASE_MS = 10 * 60_000;
/** A running video with no progress report for this long goes back on the queue. */
export const JOB_LEASE_MS = 45 * 60_000;

export const url = (path: string) => `${BASE_URL}${path}`;
