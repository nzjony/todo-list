const state = {
  todos: [],
  suggestionLimit: 6
};

const INITIAL_SUGGESTION_LIMIT = 6;
const SUGGESTION_PAGE_SIZE = 5;

const appShell = document.querySelector(".app-shell");
const pinForm = document.querySelector("#pin-form");
const pinInput = document.querySelector("#pin-input");
const pinError = document.querySelector("#pin-error");
const pinWarning = document.querySelector("#pin-warning");
const todoForm = document.querySelector("#todo-form");
const titleInput = document.querySelector("#todo-title");
const neededList = document.querySelector("#needed-list");
const completedList = document.querySelector("#completed-list");
const neededCount = document.querySelector("#needed-count");
const completedCount = document.querySelector("#completed-count");
const emptyNeeded = document.querySelector("#empty-needed");
const emptyCompleted = document.querySelector("#empty-completed");
const suggestions = document.querySelector("#suggestions");
const template = document.querySelector("#todo-template");
const logoutButton = document.querySelector("#logout-button");

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.code
      ? `${payload.code}: ${payload.error || "Request failed"}`
      : payload.error || "Request failed";
    const error = new Error(message);
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function debounce(fn, wait = 350) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

function normalizedTitle(value) {
  return value.trim().replace(/\s+/g, " ");
}

function activeTitles() {
  return new Set(
    state.todos
      .filter((todo) => !todo.completed)
      .map((todo) => todo.title.toLowerCase())
  );
}

function suggestionTitles() {
  const query = normalizedTitle(titleInput.value).toLowerCase();
  const active = activeTitles();
  const counts = new Map();

  for (const todo of state.todos) {
    if (!todo.completed) continue;

    const title = normalizedTitle(todo.title);
    const key = title.toLowerCase();
    if (!title || active.has(key)) continue;
    if (query && !key.includes(query)) continue;

    const current = counts.get(key) || {
      count: 0,
      latest: 0,
      title
    };

    current.count += 1;
    current.latest = Math.max(current.latest, new Date(todo.updatedAt || todo.createdAt).getTime());
    counts.set(key, current);
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || b.latest - a.latest || a.title.localeCompare(b.title))
    .map((item) => item.title);
}

function sortedTodos(completed) {
  return state.todos
    .filter((todo) => todo.completed === completed)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

async function updateTodo(id, patch) {
  const current = state.todos.find((todo) => todo.id === id);
  const payload = {
    title: current?.title || "",
    ...patch
  };
  const previous = [...state.todos];
  state.todos = state.todos.map((todo) => (todo.id === id ? { ...todo, ...patch } : todo));
  render();

  try {
    const { todo } = await api(`/api/todos/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    state.todos = state.todos.map((item) => (item.id === id ? todo : item));
    render();
  } catch (error) {
    state.todos = previous;
    render();
    alert(error.message);
  }
}

const debouncedTitleUpdate = debounce((id, value) => {
  const title = normalizedTitle(value);
  if (title) updateTodo(id, { title });
}, 450);

function renderItem(todo) {
  const item = template.content.firstElementChild.cloneNode(true);
  item.dataset.id = todo.id;
  item.dataset.completed = String(todo.completed);

  const completeInput = item.querySelector(".complete-input");
  const itemTitle = item.querySelector(".title-input");
  const deleteButton = item.querySelector(".delete-button");

  completeInput.checked = todo.completed;
  itemTitle.value = todo.title;

  completeInput.addEventListener("change", () => updateTodo(todo.id, { completed: completeInput.checked }));
  itemTitle.addEventListener("input", () => debouncedTitleUpdate(todo.id, itemTitle.value));
  itemTitle.addEventListener("blur", () => {
    const title = normalizedTitle(itemTitle.value);
    if (title && title !== todo.title) updateTodo(todo.id, { title });
  });
  deleteButton.addEventListener("click", () => deleteTodo(todo.id));

  return item;
}

function renderSuggestions() {
  suggestions.replaceChildren();
  const allTitles = suggestionTitles();
  const visibleTitles = allTitles.slice(0, state.suggestionLimit);
  suggestions.hidden = allTitles.length === 0;

  for (const title of visibleTitles) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = title;
    button.className = "suggestion-chip";
    button.addEventListener("click", () => addTodoFromTitle(title));
    suggestions.append(button);
  }

  if (allTitles.length > visibleTitles.length) {
    const moreButton = document.createElement("button");
    moreButton.type = "button";
    moreButton.className = "suggestion-more";
    moreButton.setAttribute("aria-label", "Show more suggestions");
    moreButton.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M6 9l6 6 6-6"></path>
      </svg>
    `;
    moreButton.addEventListener("click", () => {
      state.suggestionLimit += SUGGESTION_PAGE_SIZE;
      renderSuggestions();
    });
    suggestions.append(moreButton);
  }
}

function render() {
  const needed = sortedTodos(false);
  const completed = sortedTodos(true);

  neededCount.textContent = needed.length;
  completedCount.textContent = completed.length;
  emptyNeeded.hidden = needed.length > 0;
  emptyCompleted.hidden = completed.length > 0;

  neededList.replaceChildren(...needed.map(renderItem));
  completedList.replaceChildren(...completed.map(renderItem));
  renderSuggestions();
}

async function loadTodos() {
  const { todos } = await api("/api/todos");
  state.todos = todos;
  render();
}

async function addTodoFromTitle(rawTitle) {
  const title = normalizedTitle(rawTitle);
  if (!title) return;

  try {
    const { todo } = await api("/api/todos", {
      method: "POST",
      body: JSON.stringify({ title })
    });
    state.todos.unshift(todo);
    todoForm.reset();
    titleInput.focus();
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function addTodo(event) {
  event.preventDefault();
  await addTodoFromTitle(titleInput.value);
}

async function deleteTodo(id) {
  const previous = [...state.todos];
  state.todos = state.todos.filter((todo) => todo.id !== id);
  render();

  try {
    await api(`/api/todos/${id}`, { method: "DELETE" });
  } catch (error) {
    state.todos = previous;
    render();
    alert(error.message);
  }
}

async function login(event) {
  event.preventDefault();
  pinError.textContent = "";

  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ pin: pinInput.value })
    });
    appShell.dataset.auth = "unlocked";
    pinInput.value = "";
    await loadTodos();
  } catch (error) {
    pinError.textContent = error.message;
  }
}

async function logout() {
  await api("/api/logout", { method: "POST" });
  appShell.dataset.auth = "locked";
  state.todos = [];
  render();
  pinInput.focus();
}

async function boot() {
  const session = await api("/api/session");
  pinWarning.hidden = !session.defaultPinWarning;

  if (session.authenticated) {
    appShell.dataset.auth = "unlocked";
    await loadTodos();
  } else {
    appShell.dataset.auth = "locked";
    pinInput.focus();
  }
}

titleInput.addEventListener("input", () => {
  state.suggestionLimit = INITIAL_SUGGESTION_LIMIT;
  renderSuggestions();
});
pinForm.addEventListener("submit", login);
todoForm.addEventListener("submit", addTodo);
logoutButton.addEventListener("click", logout);

boot().catch((error) => {
  appShell.dataset.auth = "locked";
  pinError.textContent = error.message;
});
