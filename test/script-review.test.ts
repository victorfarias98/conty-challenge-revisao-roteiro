import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { ScriptView } from "../src/script-review.ts";

type App = ReturnType<typeof createApp>;
type ErrorBody = { error: { code: string; message: string } };

// 2026-03-10 12:00 em São Paulo.
const NOON = "2026-03-10T15:00:00.000Z";
// Último instante do dia 2026-03-12 em São Paulo; em UTC já é dia 13.
const LAST_INSTANT_OF_DUE_DAY = "2026-03-13T02:59:59.999Z";
const FIRST_INSTANT_OF_NEXT_DAY = "2026-03-13T03:00:00.000Z";

let app: App;
let now: Date;

function at(instant: string): void {
  now = new Date(instant);
}

async function post(path: string, role: "brand" | "creator", body?: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-role": role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function newScript(): Promise<ScriptView> {
  const res = await post("/scripts", "creator", { title: "Verão beleza", content: "Roteiro v1" });
  expect(res.status).toBe(201);
  return (await res.json()) as ScriptView;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as ErrorBody).error.code;
}

beforeEach(() => {
  at(NOON);
  app = createApp(openDatabase(), () => now);
});

describe("fluxo da revisão", () => {
  it("segue de envio a aprovação mostrando o estado e as ações permitidas em cada passo", async () => {
    const created = await newScript();
    expect(created.status).toBe("in_review");
    expect(created.allowed_actions).toEqual({ brand: ["request_changes", "approve"], creator: [] });

    const requested = (await (
      await post(`/scripts/${created.id}/change-requests`, "brand", { reason: "Citar o cupom", due_date: "2026-03-12" })
    ).json()) as ScriptView;
    expect(requested.status).toBe("changes_requested");
    expect(requested.allowed_actions).toEqual({ brand: [], creator: ["submit_version"] });
    expect(requested.change_requests).toMatchObject([
      { version: 1, reason: "Citar o cupom", due_date: "2026-03-12", deadline_passed: false },
    ]);

    const resubmitted = (await (
      await post(`/scripts/${created.id}/versions`, "creator", { content: "Roteiro v2 com cupom" })
    ).json()) as ScriptView;
    expect(resubmitted.status).toBe("in_review");
    expect(resubmitted.current_version).toBe(2);

    const approved = (await (await post(`/scripts/${created.id}/approval`, "brand")).json()) as ScriptView;
    expect(approved.status).toBe("approved");
    expect(approved.approved_version).toBe(2);
    expect(approved.allowed_actions).toEqual({ brand: [], creator: [] });
  });

  it("mantém a versão antiga quando chega uma nova", async () => {
    const script = await newScript();
    await post(`/scripts/${script.id}/change-requests`, "brand", { reason: "Encurtar", due_date: "2026-03-12" });
    await post(`/scripts/${script.id}/versions`, "creator", { content: "Roteiro v2" });

    const view = (await (await app.request(`/scripts/${script.id}`)).json()) as ScriptView;

    expect(view.versions.map((version) => [version.number, version.content])).toEqual([
      [1, "Roteiro v1"],
      [2, "Roteiro v2"],
    ]);
    expect(view.change_requests).toHaveLength(1);
  });

  it("não aceita nova versão enquanto a marca ainda revisa a atual", async () => {
    const script = await newScript();
    const res = await post(`/scripts/${script.id}/versions`, "creator", { content: "Roteiro v2" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("awaiting_brand_review");
  });

  it("não aprova com pedido de alteração em aberto", async () => {
    const script = await newScript();
    await post(`/scripts/${script.id}/change-requests`, "brand", { reason: "Encurtar", due_date: "2026-03-12" });
    const res = await post(`/scripts/${script.id}/approval`, "brand");
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("changes_pending");
  });

  it("separa as ações da marca das do criador", async () => {
    const script = await newScript();
    expect((await post(`/scripts/${script.id}/approval`, "creator")).status).toBe(403);
    expect(
      (await post(`/scripts/${script.id}/change-requests`, "creator", { reason: "x", due_date: "2026-03-12" })).status,
    ).toBe(403);
  });

  it("responde 404 para roteiro inexistente", async () => {
    expect((await app.request("/scripts/scr_nao_existe")).status).toBe(404);
  });
});

describe("pedido de alteração exige motivo e prazo", () => {
  it.each([
    ["sem motivo", { due_date: "2026-03-12" }, "reason_required"],
    ["com motivo em branco", { reason: "   ", due_date: "2026-03-12" }, "reason_required"],
    ["sem prazo", { reason: "Encurtar" }, "due_date_required"],
    ["com prazo que não é um dia", { reason: "Encurtar", due_date: "2026-02-30" }, "due_date_invalid"],
    ["com prazo com horário", { reason: "Encurtar", due_date: "2026-03-12T10:00:00Z" }, "due_date_invalid"],
  ])("recusa pedido %s", async (_label, body, code) => {
    const script = await newScript();
    const res = await post(`/scripts/${script.id}/change-requests`, "brand", body);
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe(code);
    const view = (await (await app.request(`/scripts/${script.id}`)).json()) as ScriptView;
    expect(view.status).toBe("in_review");
    expect(view.change_requests).toEqual([]);
  });
});

describe("prazo no fuso da marca", () => {
  it("aceita pedido com prazo para hoje no último instante do dia em São Paulo", async () => {
    const script = await newScript();
    at(LAST_INSTANT_OF_DUE_DAY);
    const res = await post(`/scripts/${script.id}/change-requests`, "brand", { reason: "Encurtar", due_date: "2026-03-12" });
    expect(res.status).toBe(201);
  });

  it("recusa pedido cujo prazo já passou no primeiro instante do dia seguinte", async () => {
    const script = await newScript();
    at(FIRST_INSTANT_OF_NEXT_DAY);
    const res = await post(`/scripts/${script.id}/change-requests`, "brand", { reason: "Encurtar", due_date: "2026-03-12" });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("due_date_passed");
  });

  it("aceita a nova versão no último instante do dia do prazo, mesmo com o dia UTC já virado", async () => {
    const script = await newScript();
    await post(`/scripts/${script.id}/change-requests`, "brand", { reason: "Encurtar", due_date: "2026-03-12" });
    at(LAST_INSTANT_OF_DUE_DAY);
    const res = await post(`/scripts/${script.id}/versions`, "creator", { content: "Roteiro v2" });
    expect(res.status).toBe(201);
  });

  it("recusa a nova versão no primeiro instante do dia seguinte e deixa a marca abrir outro pedido", async () => {
    const script = await newScript();
    await post(`/scripts/${script.id}/change-requests`, "brand", { reason: "Encurtar", due_date: "2026-03-12" });
    at(FIRST_INSTANT_OF_NEXT_DAY);

    const late = await post(`/scripts/${script.id}/versions`, "creator", { content: "Roteiro v2" });
    expect(late.status).toBe(409);
    expect(await errorCode(late)).toBe("deadline_passed");

    const view = (await (await app.request(`/scripts/${script.id}`)).json()) as ScriptView;
    expect(view.current_version).toBe(1);
    expect(view.change_requests[0]?.deadline_passed).toBe(true);
    expect(view.allowed_actions).toEqual({ brand: ["request_changes"], creator: [] });

    const renewed = await post(`/scripts/${script.id}/change-requests`, "brand", { reason: "Encurtar", due_date: "2026-03-15" });
    expect(renewed.status).toBe(201);
    expect((await post(`/scripts/${script.id}/versions`, "creator", { content: "Roteiro v2" })).status).toBe(201);
  });

  it("não deixa a marca empilhar pedidos enquanto o prazo do primeiro ainda vale", async () => {
    const script = await newScript();
    await post(`/scripts/${script.id}/change-requests`, "brand", { reason: "Encurtar", due_date: "2026-03-12" });
    const res = await post(`/scripts/${script.id}/change-requests`, "brand", { reason: "Outra coisa", due_date: "2026-03-13" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("changes_already_requested");
  });
});

describe("roteiro aprovado", () => {
  async function approvedScript(): Promise<ScriptView> {
    const script = await newScript();
    const res = await post(`/scripts/${script.id}/approval`, "brand");
    expect(res.status).toBe(200);
    return (await res.json()) as ScriptView;
  }

  it("não aceita nova versão", async () => {
    const script = await approvedScript();
    const res = await post(`/scripts/${script.id}/versions`, "creator", { content: "Roteiro v2" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("script_approved");
  });

  it("não aceita novo pedido de alteração", async () => {
    const script = await approvedScript();
    const res = await post(`/scripts/${script.id}/change-requests`, "brand", { reason: "Encurtar", due_date: "2026-03-12" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("script_approved");
  });

  it("não reabre nem muda a versão aprovada ao aprovar de novo", async () => {
    const script = await approvedScript();
    at("2026-03-11T15:00:00.000Z");
    const res = await post(`/scripts/${script.id}/approval`, "brand");
    expect(res.status).toBe(409);
    const view = (await (await app.request(`/scripts/${script.id}`)).json()) as ScriptView;
    expect(view.approved_version).toBe(1);
    expect(view.approved_at).toBe(NOON);
  });
});
