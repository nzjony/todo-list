import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "data");
const dataFile = join(dataDir, "todos.json");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const TODO_PIN = process.env.TODO_PIN || "1234";
const TODO_SECRET = process.env.TODO_SECRET || "change-me-before-internet";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

await mkdir(dataDir, { recursive: true });

async function readTodos() {
  try {
    const raw = await readFile(dataFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.todos) ? parsed.todos : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeTodos(todos) {
  const payload = JSON.stringify({ todos }, null, 2);
  const tempFile = `${dataFile}.${Date.now()}.tmp`;
  await writeFile(tempFile, payload, "utf8");
  await rename(tempFile, dataFile);
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function errorResponse(res, statusCode, code, error) {
  jsonResponse(res, statusCode, { code, error });
}

function notFound(res, code = "SL-404-ROUTE") {
  errorResponse(res, 404, code, "Not found");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
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

function createSessionCookie() {
  const value = `${Date.now()}.${randomUUID()}`;
  const cookie = `${value}.${sign(value)}`;
  return `todo_session=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function hasValidSession(req) {
  const cookie = parseCookies(req).todo_session;
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

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 64_000) {
      throw new Error("Request body too large");
    }
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
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
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    notFound(res);
    return;
  }

  const stream = createReadStream(filePath);
  stream.on("error", () => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  stream.pipe(res);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/session" && req.method === "GET") {
    jsonResponse(res, 200, {
      authenticated: hasValidSession(req),
      defaultPinWarning: TODO_PIN === "1234" || TODO_SECRET === "change-me-before-internet"
    });
    return;
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await readRequestJson(req);
    if (!pinMatches(body.pin)) {
      errorResponse(res, 401, "SL-401-PIN", "Incorrect PIN");
      return;
    }

    res.setHeader("Set-Cookie", createSessionCookie());
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    res.setHeader("Set-Cookie", "todo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (!hasValidSession(req)) {
    errorResponse(res, 401, "SL-401-SESSION", "PIN required");
    return;
  }

  if (url.pathname === "/api/todos" && req.method === "GET") {
    jsonResponse(res, 200, { todos: await readTodos() });
    return;
  }

  if (url.pathname === "/api/todos" && req.method === "POST") {
    const body = await readRequestJson(req);
    const todo = sanitizeTodo(body);
    if (!todo.title) {
      errorResponse(res, 400, "SL-400-TITLE", "Title is required");
      return;
    }

    const todos = await readTodos();
    todos.unshift(todo);
    await writeTodos(todos);
    jsonResponse(res, 201, { todo });
    return;
  }

  const match = url.pathname.match(/^\/api\/todos\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const body = await readRequestJson(req);
    const todos = await readTodos();
    const index = todos.findIndex((todo) => todo.id === match[1]);
    if (index === -1) {
      const recreated = sanitizeTodo(body, { id: match[1] });
      if (!recreated.title) {
        errorResponse(res, 404, "SL-404-ITEM", "Item not found");
        return;
      }

      todos.unshift(recreated);
      await writeTodos(todos);
      jsonResponse(res, 200, { todo: recreated, repaired: true });
      return;
    }

    const updated = sanitizeTodo(body, todos[index]);
    if (!updated.title) {
      errorResponse(res, 400, "SL-400-TITLE", "Title is required");
      return;
    }

    todos[index] = updated;
    await writeTodos(todos);
    jsonResponse(res, 200, { todo: updated });
    return;
  }

  if (match && req.method === "DELETE") {
    const todos = await readTodos();
    const nextTodos = todos.filter((todo) => todo.id !== match[1]);
    if (nextTodos.length === todos.length) {
      notFound(res, "SL-404-ITEM");
      return;
    }

    await writeTodos(nextTodos);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  notFound(res);
}

const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    errorResponse(res, 500, "SL-500-SERVER", "Something went wrong");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Reminders app running at http://${HOST}:${PORT}`);
  if (TODO_PIN === "1234") {
    console.log("Using development PIN 1234. Set TODO_PIN before exposing this app.");
  }
});
