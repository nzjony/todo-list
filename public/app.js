const state = {
  todos: []
};

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
    throw new Error(payload.error || "Request failed");
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
  const seen = new Set();

  return state.todos
    .filter((todo) => todo.completed)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .map((todo) => normalizedTitle(todo.title))
    .filter((title) => {
      const key = title.toLowerCase();
      if (!title || seen.has(key) || active.has(key)) return false;
      if (query && !key.includes(query)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function sortedTodos(completed) {
  return state.todos
    .filter((todo) => todo.completed === completed)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

async function updateTodo(id, patch) {
  const previous = [...state.todos];
  state.todos = state.todos.map((todo) => (todo.id === id ? { ...todo, ...patch } : todo));
  render();

  try {
    const { todo } = await api(`/api/todos/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
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
  const titles = suggestionTitles();
  suggestions.hidden = titles.length === 0;

  for (const title of titles) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = title;
    button.addEventListener("click", () => addTodoFromTitle(title));
    suggestions.append(button);
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

titleInput.addEventListener("input", renderSuggestions);
pinForm.addEventListener("submit", login);
todoForm.addEventListener("submit", addTodo);
logoutButton.addEventListener("click", logout);

boot().catch((error) => {
  appShell.dataset.auth = "locked";
  pinError.textContent = error.message;
});
