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

function config(env) {
  return {
    todoPin: env.TODO_PIN || "1234",
    todoSecret: env.TODO_SECRET || "change-me-before-internet"
  };
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

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

async function createSessionCookie(request, secret) {
  const value = `${Date.now()}.${crypto.randomUUID()}`;
  const cookie = `${value}.${await sign(value, secret)}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `todo_session=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

async function hasValidSession(request, secret) {
  const cookie = parseCookies(request).todo_session;
  if (!cookie) return false;

  const parts = cookie.split(".");
  if (parts.length < 3) return false;

  const signature = parts.pop();
  const value = parts.join(".");
  return signature === (await sign(value, secret));
}

function pinMatches(pin, expectedPin) {
  return String(pin || "") === expectedPin;
}

function store(env) {
  return env.TODO_LIST;
}

async function readTodos(env) {
  const kv = store(env);
  if (!kv) throw new Error("Missing TODO_LIST KV binding");
  const data = await kv.get(TODOS_KEY, "json");
  return Array.isArray(data?.todos) ? data.todos : [];
}

async function writeTodos(env, todos) {
  const kv = store(env);
  if (!kv) throw new Error("Missing TODO_LIST KV binding");
  await kv.put(TODOS_KEY, JSON.stringify({ todos }));
}

function sanitizeTodo(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
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

export async function onRequest(context) {
  const { request, env } = context;
  const { todoPin, todoSecret } = config(env);

  try {
    const pathname = new URL(request.url).pathname;
    const method = request.method;

    if (pathname === "/api/session" && method === "GET") {
      return jsonResponse(200, {
        authenticated: await hasValidSession(request, todoSecret),
        defaultPinWarning: todoPin === "1234" || todoSecret === "change-me-before-internet"
      });
    }

    if (pathname === "/api/login" && method === "POST") {
      const body = await request.json();
      if (!pinMatches(body.pin, todoPin)) {
        return errorResponse(401, "SL-401-PIN", "Incorrect PIN");
      }

      return jsonResponse(200, { ok: true }, { "Set-Cookie": await createSessionCookie(request, todoSecret) });
    }

    if (pathname === "/api/logout" && method === "POST") {
      return jsonResponse(200, { ok: true }, {
        "Set-Cookie": "todo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
      });
    }

    if (!(await hasValidSession(request, todoSecret))) {
      return errorResponse(401, "SL-401-SESSION", "PIN required");
    }

    if (pathname === "/api/todos" && method === "GET") {
      return jsonResponse(200, { todos: await readTodos(env) });
    }

    if (pathname === "/api/todos" && method === "POST") {
      const body = await request.json();
      const todo = sanitizeTodo(body);
      if (!todo.title) {
        return errorResponse(400, "SL-400-TITLE", "Title is required");
      }

      const todos = await readTodos(env);
      todos.unshift(todo);
      await writeTodos(env, todos);
      return jsonResponse(201, { todo });
    }

    const match = pathname.match(/^\/api\/todos\/([^/]+)$/);
    if (match && method === "PATCH") {
      const body = await request.json();
      const todos = await readTodos(env);
      const index = todos.findIndex((todo) => todo.id === match[1]);
      if (index === -1) {
        const recreated = sanitizeTodo(body, { id: match[1] });
        if (!recreated.title) {
          return errorResponse(404, "SL-404-ITEM", "Item not found");
        }

        todos.unshift(recreated);
        await writeTodos(env, todos);
        return jsonResponse(200, { todo: recreated, repaired: true });
      }

      const updated = sanitizeTodo(body, todos[index]);
      if (!updated.title) {
        return errorResponse(400, "SL-400-TITLE", "Title is required");
      }

      todos[index] = updated;
      await writeTodos(env, todos);
      return jsonResponse(200, { todo: updated });
    }

    if (match && method === "DELETE") {
      const todos = await readTodos(env);
      const nextTodos = todos.filter((todo) => todo.id !== match[1]);
      if (nextTodos.length === todos.length) {
        return errorResponse(404, "SL-404-ITEM", "Item not found");
      }

      await writeTodos(env, nextTodos);
      return jsonResponse(200, { ok: true });
    }

    return errorResponse(404, "SL-404-ROUTE", "Not found");
  } catch (error) {
    console.error(error);
    const message = error.message === "Missing TODO_LIST KV binding"
      ? "Cloudflare KV binding TODO_LIST is not configured"
      : "Something went wrong";
    const code = error.message === "Missing TODO_LIST KV binding" ? "SL-500-KV" : "SL-500-SERVER";
    return errorResponse(500, code, message);
  }
}
