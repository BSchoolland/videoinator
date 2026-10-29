// The worker's side of the site API. The site never calls in; everything is a pull from here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const file of [path.join(import.meta.dirname, ".env"), path.join(os.homedir(), ".config/videoinator/env")]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}
export const SITE = (process.env.SITE ?? "").replace(/\/$/, "");
const TOKEN = process.env.WORKER_TOKEN ?? "";
if (!SITE || !TOKEN) throw new Error("SITE and WORKER_TOKEN must be set (env, worker/.env or ~/.config/videoinator/env)");

export async function call(p: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${SITE}/api/worker${p}`, { ...init, headers: { "x-worker-token": TOKEN, "content-type": "application/json", ...(init.headers ?? {}) } });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? "GET"} ${p}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}
export const get = async <T>(p: string): Promise<T | null> => { const r = await call(p); return r.status === 204 ? null : (await r.json()) as T; };
export const post = async <T = unknown>(p: string, body: unknown): Promise<T> => (await (await call(p, { method: "POST", body: JSON.stringify(body) })).json()) as T;
export const upload = async <T = unknown>(p: string, file: string): Promise<T> =>
  (await (await call(p, { method: "POST", body: fs.readFileSync(file), headers: { "content-type": "application/octet-stream" } })).json()) as T;

export interface Request { id: string; name: string; email: string; idea: string; status: string }
export interface User { id: string; name: string; email: string; credits: number; used: number }
export interface Media { url: string; type: "video" | "image"; caption?: string }
export interface Message { id: number; sender: "user" | "bot"; kind: "text" | "media" | "plan" | "edit"; body: string; media: Media[]; created_at: number }
export interface Chat { id: string; user_id: string; session_id: string | null; claimed_upto: number | null }
export interface Job { id: string; chat_id: string; plan_msg_id: number; parent_id: string | null; attempts: number; finished_at: number | null }
