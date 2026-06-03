import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const TODO_PIN = process.env.TODO_PIN || "1234";
const TODO_SECRET = process.env.TODO_SECRET || "change-me-before-internet";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const TODOS_KEY = "todos";

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function errorResponse(status, code, error) {
  return jsonResponse(status, { code, error });
}

function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function sign(value) {
  return createHmac("sha256", TODO_SECRET).update(value).digest("base64url");
}

function createSessionCookie(request) {
  const value = `${Date.now()}.${randomUUID()}`;
  const cookie = `${value}.${sign(value)}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `todo_session=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

function hasValidSession(request) {
  const cookie = parseCookies(request).todo_session;
  if (!cookie) return false;

  const parts = cookie.split(".");
  if (parts.length < 3) return false;

  const signature = parts.pop();
  const value = parts.join(".");
  const expected = sign(value);

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function pinMatches(pin) {
  const expected = Buffer.from(TODO_PIN);
  const actual = Buffer.from(String(pin || ""));
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

async function readTodos() {
  const store = getStore("personal-reminders");
  const data = await store.get(TODOS_KEY, { type: "json" });
  return Array.isArray(data?.todos) ? data.todos : [];
}

async function writeTodos(todos) {
  const store = getStore("personal-reminders");
  await store.setJSON(TODOS_KEY, { todos });
}

function sanitizeTodo(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || randomUUID(),
    title: String(input.title || existing.title || "").trim().slice(0, 180),
    notes: String(input.notes ?? existing.notes ?? "").trim().slice(0, 2000),
    dueDate: String(input.dueDate ?? existing.dueDate ?? "").slice(0, 10),
    priority: ["none", "low", "medium", "high"].includes(input.priority)
      ? input.priority
      : existing.priority || "none",
    completed: Boolean(input.completed ?? existing.completed ?? false),
    latitude: input.latitude === null ? null : typeof input.latitude === "number" ? input.latitude : existing.latitude ?? null,
    longitude: input.longitude === null ? null : typeof input.longitude === "number" ? input.longitude : existing.longitude ?? null,
    locationName: String(input.locationName ?? existing.locationName ?? "").trim().slice(0, 80),
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function apiPath(request) {
  const pathname = new URL(request.url).pathname;
  const functionPrefix = "/.netlify/functions/api";
  if (pathname.startsWith(functionPrefix)) {
    return `/api${pathname.slice(functionPrefix.length)}`;
  }
  return pathname;
}

export default async (request) => {
  try {
    const pathname = apiPath(request);
    const method = request.method;

    if (pathname === "/api/session" && method === "GET") {
      return jsonResponse(200, {
        authenticated: hasValidSession(request),
        defaultPinWarning: TODO_PIN === "1234" || TODO_SECRET === "change-me-before-internet"
      });
    }

    if (pathname === "/api/login" && method === "POST") {
      const body = await request.json();
      if (!pinMatches(body.pin)) {
        return errorResponse(401, "SL-401-PIN", "Incorrect PIN");
      }

      return jsonResponse(200, { ok: true }, { "Set-Cookie": createSessionCookie(request) });
    }

    if (pathname === "/api/logout" && method === "POST") {
      return jsonResponse(200, { ok: true }, {
        "Set-Cookie": "todo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
      });
    }

    if (!hasValidSession(request)) {
      return errorResponse(401, "SL-401-SESSION", "PIN required");
    }

    if (pathname === "/api/todos" && method === "GET") {
      return jsonResponse(200, { todos: await readTodos() });
    }

    if (pathname === "/api/todos" && method === "POST") {
      const body = await request.json();
      const todo = sanitizeTodo(body);
      if (!todo.title) {
        return errorResponse(400, "SL-400-TITLE", "Title is required");
      }

      const todos = await readTodos();
      todos.unshift(todo);
      await writeTodos(todos);
      return jsonResponse(201, { todo });
    }

    const match = pathname.match(/^\/api\/todos\/([^/]+)$/);
    if (match && method === "PATCH") {
      const body = await request.json();
      const todos = await readTodos();
      const index = todos.findIndex((todo) => todo.id === match[1]);
      if (index === -1) {
        const recreated = sanitizeTodo(body, { id: match[1] });
        if (!recreated.title) {
          return errorResponse(404, "SL-404-ITEM", "Item not found");
        }

        todos.unshift(recreated);
        await writeTodos(todos);
        return jsonResponse(200, { todo: recreated, repaired: true });
      }

      const updated = sanitizeTodo(body, todos[index]);
      if (!updated.title) {
        return errorResponse(400, "SL-400-TITLE", "Title is required");
      }

      todos[index] = updated;
      await writeTodos(todos);
      return jsonResponse(200, { todo: updated });
    }

    if (match && method === "DELETE") {
      const todos = await readTodos();
      const nextTodos = todos.filter((todo) => todo.id !== match[1]);
      if (nextTodos.length === todos.length) {
        return errorResponse(404, "SL-404-ITEM", "Item not found");
      }

      await writeTodos(nextTodos);
      return jsonResponse(200, { ok: true });
    }

    return errorResponse(404, "SL-404-ROUTE", "Not found");
  } catch (error) {
    console.error(error);
    return errorResponse(500, "SL-500-SERVER", "Something went wrong");
  }
};
