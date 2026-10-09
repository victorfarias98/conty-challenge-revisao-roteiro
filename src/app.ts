import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { type Clock, ReviewError, createScriptReview } from "./script-review.ts";

type Role = "brand" | "creator";

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function createApp(db: DatabaseSync, clock: Clock = () => new Date()) {
  const review = createScriptReview(db, clock);
  const app = new Hono();

  // Sem autenticação neste desafio: o cabeçalho x-role só separa o que é da marca do que é do criador.
  function requireRole(c: Context, role: Role): Response | null {
    if (c.req.header("x-role") === role) return null;
    return c.json({ error: { code: "forbidden", message: `ação exclusiva de x-role: ${role}` } }, 403);
  }

  app.onError((error, c) => {
    if (error instanceof ReviewError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: "internal_error", message: "erro interno" } }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/scripts", async (c) => requireRole(c, "creator") ?? c.json(review.create(await jsonBody(c)), 201));

  app.get("/scripts/:id", (c) => c.json(review.view(c.req.param("id"))));

  app.post(
    "/scripts/:id/versions",
    async (c) =>
      requireRole(c, "creator") ?? c.json(review.submitVersion(c.req.param("id"), await jsonBody(c)), 201),
  );

  app.post(
    "/scripts/:id/change-requests",
    async (c) =>
      requireRole(c, "brand") ?? c.json(review.requestChanges(c.req.param("id"), await jsonBody(c)), 201),
  );

  app.post("/scripts/:id/approval", (c) => requireRole(c, "brand") ?? c.json(review.approve(c.req.param("id"))));

  return app;
}
