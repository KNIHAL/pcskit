import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  getStatus,
  latestEvidenceByTask,
  listNotes,
  listSessions,
  listSnapshots,
  listTasks,
  recentEvents,
  recentTestRuns,
  withDb,
  type EvidenceSummary,
} from "../core";
import { PAGE } from "./page";

export interface DashboardOptions {
  project: string;
  /** 0 picks a free port. Default 7777. */
  port?: number | undefined;
}

export interface DashboardHandle {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const COOKIE = "pcs_dash";
const MAX_EVENTS = 100;
const MAX_SUMMARY = 300;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function summarize(payload: string): string {
  const text = payload.replace(CONTROL, "");
  return text === "null" || text === "{}" || text === "" ? "" : text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

export async function buildOverview(project: string) {
  const status = await getStatus(project);
  const [sessions, snapshots] = await Promise.all([listSessions(project, 8), listSnapshots(project, 8)]);
  const [tasks, notes] = await Promise.all([listTasks(project), listNotes(project, { all: true })]);
  const data = await withDb(project, (db) => {
    const evidence: Record<number, EvidenceSummary> = {};
    for (const [taskId, ev] of latestEvidenceByTask(db)) evidence[taskId] = ev;
    const events = recentEvents(db, MAX_EVENTS);
    const last = (type: string) => events.find((e) => e.type === type) ?? null;
    return {
      evidence,
      runs: recentTestRuns(db, { limit: 10 }),
      events: events.map((e) => ({
        id: e.id,
        ts: e.ts,
        type: e.type,
        provenance: e.provenance,
        source: e.source,
        session_id: e.session_id,
        summary: summarize(e.payload),
      })),
      lastHandoff: ((e) => (e ? { id: e.id, ts: e.ts } : null))(last("handoff.generated")),
      lastPickup: ((e) => (e ? { id: e.id, ts: e.ts, source: e.source } : null))(last("handoff.picked_up")),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    status: { project: status.project, git: status.git, session: status.session, integrity: status.integrity, watcher: status.watcher },
    sessions,
    snapshots,
    tasks: tasks.slice(-50),
    notes: notes.slice(-30),
    ...data,
    runs: data.runs.map((r) => ({
      id: r.id,
      ts: r.ts,
      argv: r.argv,
      outcome: r.outcome,
      exit_code: r.exit_code,
      duration_ms: r.duration_ms,
      head: r.head,
      output: r.outcome === "passed" ? "" : r.output.replace(CONTROL, ""),
    })),
  };
}

/**
 * A read-only local view of the project. Loopback only; every request needs the random
 * token (given once in the URL, then kept in a SameSite=Strict cookie); the Host header
 * must name loopback (blocks DNS rebinding); only GET is served; a strict CSP applies.
 */
export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const project = options.project;
  await getStatus(project); // fail early if this is not an initialized PCS project
  const token = randomBytes(24).toString("hex");
  let port = 0;

  const send = (res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8", extra: Record<string, string> = {}) => {
    res.writeHead(code, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...extra,
    });
    res.end(body);
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, "Forbidden host.");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Read-only.", "text/plain; charset=utf-8", { Allow: "GET, HEAD" });

    const url = new URL(req.url ?? "/", `http://${host}`);
    const given = url.searchParams.get("t");
    if (given !== null) {
      if (!sameToken(given, token)) return send(res, 401, "Bad token.");
      return send(res, 302, "", "text/plain", {
        Location: "/",
        "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }
    const have = cookieToken(req);
    if (have === null || !sameToken(have, token)) return send(res, 401, "Open the URL that `pcs dashboard` printed (it contains the access token).");

    if (url.pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      const page = PAGE.replace("<style>", `<style nonce="${nonce}">`).replace("<script>", `<script nonce="${nonce}">`);
      return send(res, 200, page, "text/html; charset=utf-8", {
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (url.pathname === "/api/overview") {
      try {
        return send(res, 200, JSON.stringify(await buildOverview(project)), "application/json; charset=utf-8");
      } catch (err) {
        return send(res, 500, JSON.stringify({ error: err instanceof Error ? err.message : "error" }), "application/json; charset=utf-8");
      }
    }
    return send(res, 404, "Not found.");
  };

  const server: Server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Error.");
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 7777, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
