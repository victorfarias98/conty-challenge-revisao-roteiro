import type { DatabaseSync } from "node:sqlite";
import { isCalendarDay, isDeadlinePassed } from "./deadline.ts";

export type ScriptStatus = "in_review" | "changes_requested" | "approved";
export type Action = "request_changes" | "approve" | "submit_version";
export type Clock = () => Date;

export type ScriptView = {
  id: string;
  title: string;
  status: ScriptStatus;
  current_version: number;
  approved_version: number | null;
  approved_at: string | null;
  // O que cada lado pode fazer agora, para ninguém precisar adivinhar a partir do status.
  allowed_actions: { brand: Action[]; creator: Action[] };
  versions: Array<{ number: number; content: string; submitted_at: string }>;
  change_requests: Array<{
    id: string;
    version: number;
    reason: string;
    due_date: string;
    requested_at: string;
    deadline_passed: boolean;
  }>;
};

export class ReviewError extends Error {
  readonly status: 404 | 409 | 422;
  readonly code: string;

  constructor(status: 404 | 409 | 422, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type ScriptRow = {
  id: string;
  title: string;
  status: ScriptStatus;
  approved_version: number | null;
  approved_at: string | null;
};
type VersionRow = { number: number; content: string; submitted_at: string };
type ChangeRequestRow = { id: string; version: number; reason: string; due_date: string; requested_at: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createScriptReview(db: DatabaseSync, clock: Clock) {
  function load(id: string) {
    const script = db.prepare("SELECT * FROM scripts WHERE id = ?").get(id) as ScriptRow | undefined;
    if (!script) throw new ReviewError(404, "script_not_found", "roteiro não encontrado");
    const versions = db
      .prepare("SELECT number, content, submitted_at FROM script_versions WHERE script_id = ? ORDER BY number")
      .all(id) as VersionRow[];
    const requests = db
      .prepare(
        "SELECT id, version, reason, due_date, requested_at FROM change_requests WHERE script_id = ? ORDER BY requested_at, rowid",
      )
      .all(id) as ChangeRequestRow[];
    return { script, versions, requests, currentVersion: versions.length };
  }

  // O pedido em aberto é o último feito sobre a versão atual; pedidos de versões antigas já foram respondidos.
  function openRequestExpired(state: ReturnType<typeof load>): boolean {
    const open = state.requests.filter((request) => request.version === state.currentVersion).at(-1);
    return open ? isDeadlinePassed(clock(), open.due_date) : false;
  }

  function allowedActions(state: ReturnType<typeof load>): ScriptView["allowed_actions"] {
    if (state.script.status === "approved") return { brand: [], creator: [] };
    if (state.script.status === "in_review") return { brand: ["request_changes", "approve"], creator: [] };
    // Prazo vencido sem resposta: o pedido não vale mais e a marca precisa abrir outro, com prazo novo.
    return openRequestExpired(state)
      ? { brand: ["request_changes"], creator: [] }
      : { brand: [], creator: ["submit_version"] };
  }

  function view(id: string): ScriptView {
    const state = load(id);
    const now = clock();
    return {
      id: state.script.id,
      title: state.script.title,
      status: state.script.status,
      current_version: state.currentVersion,
      approved_version: state.script.approved_version,
      approved_at: state.script.approved_at,
      allowed_actions: allowedActions(state),
      versions: state.versions,
      change_requests: state.requests.map((request) => ({
        ...request,
        deadline_passed: isDeadlinePassed(now, request.due_date),
      })),
    };
  }

  function assertNotApproved(script: ScriptRow): void {
    if (script.status === "approved") {
      throw new ReviewError(409, "script_approved", "roteiro aprovado não aceita nova versão nem pedido de alteração");
    }
  }

  function create(input: { title?: unknown; content?: unknown }): ScriptView {
    const title = text(input.title);
    const content = text(input.content);
    if (!title) throw new ReviewError(422, "title_required", "título é obrigatório");
    if (!content) throw new ReviewError(422, "content_required", "conteúdo do roteiro é obrigatório");
    const id = `scr_${crypto.randomUUID()}`;
    const now = clock().toISOString();
    transaction(db, () => {
      db.prepare("INSERT INTO scripts (id, title, status, created_at) VALUES (?, ?, 'in_review', ?)").run(id, title, now);
      db.prepare("INSERT INTO script_versions (script_id, number, content, submitted_at) VALUES (?, 1, ?, ?)").run(
        id,
        content,
        now,
      );
    });
    return view(id);
  }

  function requestChanges(id: string, input: { reason?: unknown; due_date?: unknown }): ScriptView {
    return transaction(db, () => {
      const state = load(id);
      assertNotApproved(state.script);
      const reason = text(input.reason);
      const dueDate = text(input.due_date);
      if (!reason) throw new ReviewError(422, "reason_required", "pedido de alteração precisa de motivo");
      if (!dueDate) throw new ReviewError(422, "due_date_required", "pedido de alteração precisa de prazo");
      if (!isCalendarDay(dueDate)) {
        throw new ReviewError(422, "due_date_invalid", "prazo deve ser um dia no formato AAAA-MM-DD");
      }
      if (isDeadlinePassed(clock(), dueDate)) {
        throw new ReviewError(422, "due_date_passed", "prazo já passou no fuso da marca (America/Sao_Paulo)");
      }
      if (state.script.status === "changes_requested" && !openRequestExpired(state)) {
        throw new ReviewError(409, "changes_already_requested", "já existe pedido de alteração dentro do prazo");
      }
      db.prepare(
        "INSERT INTO change_requests (id, script_id, version, reason, due_date, requested_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(`chg_${crypto.randomUUID()}`, id, state.currentVersion, reason, dueDate, clock().toISOString());
      db.prepare("UPDATE scripts SET status = 'changes_requested' WHERE id = ?").run(id);
      return view(id);
    });
  }

  function submitVersion(id: string, input: { content?: unknown }): ScriptView {
    return transaction(db, () => {
      const state = load(id);
      assertNotApproved(state.script);
      if (state.script.status === "in_review") {
        throw new ReviewError(409, "awaiting_brand_review", "a versão atual ainda está em revisão pela marca");
      }
      if (openRequestExpired(state)) {
        throw new ReviewError(409, "deadline_passed", "o prazo do pedido de alteração já passou");
      }
      const content = text(input.content);
      if (!content) throw new ReviewError(422, "content_required", "conteúdo do roteiro é obrigatório");
      db.prepare("INSERT INTO script_versions (script_id, number, content, submitted_at) VALUES (?, ?, ?, ?)").run(
        id,
        state.currentVersion + 1,
        content,
        clock().toISOString(),
      );
      db.prepare("UPDATE scripts SET status = 'in_review' WHERE id = ?").run(id);
      return view(id);
    });
  }

  function approve(id: string): ScriptView {
    return transaction(db, () => {
      const state = load(id);
      if (state.script.status === "approved") {
        throw new ReviewError(409, "script_approved", "roteiro já aprovado; a aprovação não reabre");
      }
      if (state.script.status === "changes_requested") {
        throw new ReviewError(409, "changes_pending", "há pedido de alteração em aberto para a versão atual");
      }
      db.prepare("UPDATE scripts SET status = 'approved', approved_version = ?, approved_at = ? WHERE id = ?").run(
        state.currentVersion,
        clock().toISOString(),
        id,
      );
      return view(id);
    });
  }

  return { create, view, requestChanges, submitVersion, approve };
}
