const state = {
  todos: [],
  filter: "active",
  search: ""
};

const appShell = document.querySelector(".app-shell");
const pinForm = document.querySelector("#pin-form");
const pinInput = document.querySelector("#pin-input");
const pinError = document.querySelector("#pin-error");
const pinWarning = document.querySelector("#pin-warning");
const todoForm = document.querySelector("#todo-form");
const todoList = document.querySelector("#todo-list");
const template = document.querySelector("#todo-template");
const emptyState = document.querySelector("#empty-state");
const searchInput = document.querySelector("#search-input");
const logoutButton = document.querySelector("#logout-button");
const viewLabel = document.querySelector("#view-label");
const viewTitle = document.querySelector("#view-title");

const filterTitles = {
  active: ["Active", "Things to do"],
  today: ["Today", "Due today"],
  scheduled: ["Scheduled", "Planned reminders"],
  completed: ["Completed", "Finished reminders"]
};

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

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function visibleTodos() {
  const today = todayString();
  const search = state.search.trim().toLowerCase();

  return state.todos.filter((todo) => {
    const matchesFilter =
      state.filter === "completed"
        ? todo.completed
        : state.filter === "today"
          ? !todo.completed && todo.dueDate === today
          : state.filter === "scheduled"
            ? !todo.completed && Boolean(todo.dueDate)
            : !todo.completed;

    const matchesSearch =
      !search ||
      todo.title.toLowerCase().includes(search) ||
      todo.notes.toLowerCase().includes(search);

    return matchesFilter && matchesSearch;
  });
}

function countBy(filter) {
  const today = todayString();
  if (filter === "completed") return state.todos.filter((todo) => todo.completed).length;
  if (filter === "today") return state.todos.filter((todo) => !todo.completed && todo.dueDate === today).length;
  if (filter === "scheduled") return state.todos.filter((todo) => !todo.completed && todo.dueDate).length;
  return state.todos.filter((todo) => !todo.completed).length;
}

function debounce(fn, wait = 400) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
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

const debouncedUpdate = debounce(updateTodo);

function renderCounts() {
  for (const filter of ["active", "today", "scheduled", "completed"]) {
    document.querySelector(`#${filter}-count`).textContent = countBy(filter);
  }
}

function renderFilters() {
  document.querySelectorAll(".filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.filter);
  });
  const [label, title] = filterTitles[state.filter];
  viewLabel.textContent = label;
  viewTitle.textContent = title;
}

function renderTodos() {
  const todos = visibleTodos().sort((a, b) => {
    if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate !== b.dueDate) return a.dueDate ? -1 : 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  todoList.replaceChildren();
  emptyState.hidden = todos.length > 0;

  for (const todo of todos) {
    const item = template.content.firstElementChild.cloneNode(true);
    item.dataset.id = todo.id;
    item.dataset.completed = String(todo.completed);
    item.dataset.priority = todo.priority;

    const completeInput = item.querySelector(".complete-input");
    const titleInput = item.querySelector(".title-input");
    const notesInput = item.querySelector(".notes-input");
    const dueInput = item.querySelector(".due-input");
    const priorityInput = item.querySelector(".priority-input");
    const deleteButton = item.querySelector(".delete-button");

    completeInput.checked = todo.completed;
    titleInput.value = todo.title;
    notesInput.value = todo.notes;
    dueInput.value = todo.dueDate;
    priorityInput.value = todo.priority;

    completeInput.addEventListener("change", () => updateTodo(todo.id, { completed: completeInput.checked }));
    titleInput.addEventListener("input", () => debouncedUpdate(todo.id, { title: titleInput.value }));
    notesInput.addEventListener("input", () => debouncedUpdate(todo.id, { notes: notesInput.value }));
    dueInput.addEventListener("change", () => updateTodo(todo.id, { dueDate: dueInput.value }));
    priorityInput.addEventListener("change", () => updateTodo(todo.id, { priority: priorityInput.value }));
    deleteButton.addEventListener("click", () => deleteTodo(todo.id));

    todoList.append(item);
  }
}

function render() {
  renderCounts();
  renderFilters();
  renderTodos();
}

async function loadTodos() {
  const { todos } = await api("/api/todos");
  state.todos = todos;
  render();
}

async function addTodo(event) {
  event.preventDefault();
  const formData = new FormData(todoForm);
  const payload = Object.fromEntries(formData.entries());

  try {
    const { todo } = await api("/api/todos", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.todos.unshift(todo);
    todoForm.reset();
    document.querySelector("#todo-title").focus();
    render();
  } catch (error) {
    alert(error.message);
  }
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

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    render();
  });
});

searchInput.addEventListener("input", () => {
  state.search = searchInput.value;
  render();
});

pinForm.addEventListener("submit", login);
todoForm.addEventListener("submit", addTodo);
logoutButton.addEventListener("click", logout);

boot().catch((error) => {
  appShell.dataset.auth = "locked";
  pinError.textContent = error.message;
});
