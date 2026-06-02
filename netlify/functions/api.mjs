import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const TODO_PIN = process.env.TODO_PIN || "1234";
const TODO_SECRET = process.env.TODO_SECRET || "change-me-before-internet";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
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
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function audioExtension(mimeType) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

function parseShoppingItems(transcript) {
  return transcript
    .replace(/\b(add|please add|put|please put|buy|get|we need|i need|to the list|on the list|shopping list)\b/gi, " ")
    .split(/,|\n|\band\b|\bplus\b|;/i)
    .map((item) => item.replace(/[.!?]$/g, "").trim().replace(/\s+/g, " "))
    .filter((item) => item.length > 0)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index)
    .slice(0, 20);
}

async function transcribeAudioPayload(body) {
  if (!OPENAI_API_KEY) {
    return { error: { status: 500, code: "SL-500-OPENAI-KEY", message: "OpenAI API key is not configured" } };
  }

  const mimeType = String(body.mimeType || "audio/webm");
  const audioBase64 = String(body.audioBase64 || "");
  if (!audioBase64) {
    return { error: { status: 400, code: "SL-400-AUDIO", message: "Audio is required" } };
  }

  const audioBytes = Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0));
  if (!audioBytes.length || audioBytes.length > 8_000_000) {
    return { error: { status: 400, code: "SL-400-AUDIO-SIZE", message: "Audio is too large" } };
  }

  const formData = new FormData();
  const file = new Blob([audioBytes], { type: mimeType });
  formData.append("file", file, `shopping.${audioExtension(mimeType)}`);
  formData.append("model", TRANSCRIPTION_MODEL);
  formData.append("response_format", "json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: formData
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      error: {
        status: 502,
        code: "SL-502-TRANSCRIBE",
        message: payload.error?.message || "Transcription failed"
      }
    };
  }

  const transcript = String(payload.text || "").trim();
  return { transcript, items: parseShoppingItems(transcript) };
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

    if (pathname === "/api/transcribe" && method === "POST") {
      const body = await request.json();
      const result = await transcribeAudioPayload(body);
      if (result.error) {
        return errorResponse(result.error.status, result.error.code, result.error.message);
      }

      return jsonResponse(200, result);
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
