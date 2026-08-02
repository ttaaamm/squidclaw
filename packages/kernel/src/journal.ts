import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionKind, ExecutionRecord, Graph, StepRecord } from "./types.js";

/** What the agent has lived. Every execution, every step, every input and output. */
export class Journal {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, graph TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS steps (
        execution_id TEXT NOT NULL, tenant_id TEXT NOT NULL, seq INTEGER NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY (execution_id, seq));`);
  }

  begin(meta: { tenantId: string; kind: ExecutionKind; graph: Graph }): string {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO executions VALUES (?,?,?,?,?,?,NULL)`)
      .run(id, meta.tenantId, meta.kind, "running", JSON.stringify(meta.graph), new Date().toISOString());
    return id;
  }

  recordStep(executionId: string, step: StepRecord): void {
    const row = this.db
      .prepare(
        `SELECT e.tenant_id AS tenant_id, COALESCE(MAX(s.seq),0) AS mx
         FROM executions e LEFT JOIN steps s ON s.execution_id = e.id
         WHERE e.id = ?`,
      )
      .get(executionId) as { tenant_id: string; mx: number } | undefined;
    if (!row?.tenant_id) throw new Error(`Unknown execution: ${executionId}`);
    this.db
      .prepare(`INSERT INTO steps VALUES (?,?,?,?)`)
      .run(executionId, row.tenant_id, row.mx + 1, JSON.stringify(step));
  }

  /** The improviser grows its graph as it thinks; this saves the final shape. */
  setGraph(executionId: string, graph: Graph): void {
    this.db.prepare(`UPDATE executions SET graph = ? WHERE id = ?`).run(JSON.stringify(graph), executionId);
  }

  finish(executionId: string, status: "ok" | "error"): void {
    this.db
      .prepare(`UPDATE executions SET status = ?, finished_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), executionId);
  }

  get(executionId: string): ExecutionRecord | undefined {
    const e = this.db.prepare(`SELECT * FROM executions WHERE id = ?`).get(executionId) as
      | Record<string, string | null>
      | undefined;
    if (!e) return undefined;
    const steps = (
      this.db.prepare(`SELECT data FROM steps WHERE execution_id = ? ORDER BY seq`).all(executionId) as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data) as StepRecord);
    return {
      id: e.id as string,
      tenantId: e.tenant_id as string,
      kind: e.kind as ExecutionKind,
      status: e.status as ExecutionRecord["status"],
      graph: JSON.parse(e.graph as string) as Graph,
      steps,
      startedAt: e.started_at as string,
      finishedAt: e.finished_at ?? undefined,
    };
  }

  list(opts: { tenantId?: string; limit?: number } = {}): ExecutionRecord[] {
    const limit = opts.limit ?? 50;
    const rows = (
      opts.tenantId
        ? this.db
            .prepare(`SELECT id FROM executions WHERE tenant_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`)
            .all(opts.tenantId, limit)
        : this.db.prepare(`SELECT id FROM executions ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(limit)
    ) as { id: string }[];
    return rows.map((r) => this.get(r.id)!);
  }

  close(): void {
    this.db.close();
  }
}
