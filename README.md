# Shopping List

A tiny dependency-free shopping list web app with a shared PIN gate and local JSON storage.

## Run locally

```sh
TODO_PIN=2468 TODO_SECRET="replace-with-a-long-random-string" node server.js
```

Open `http://localhost:3000`.

The server binds to `0.0.0.0` by default so it can sit behind a reverse proxy, router port forward, or tunnel. Set `PORT` or `HOST` if needed:

```sh
PORT=8080 HOST=0.0.0.0 TODO_PIN=2468 TODO_SECRET="replace-with-a-long-random-string" node server.js
```

## Cloudflare Pages

This project is Cloudflare Pages-ready. It publishes `public/`, routes `/api/*` to a Pages Function, and stores shopping items in a Cloudflare KV namespace bound as `TODO_LIST`.

In Cloudflare:

1. Create a Pages project from the GitHub repo.
2. Use no build command.
3. Set build output directory to `public`.
4. Create a KV namespace for the list.
5. Bind that namespace to the Pages project as `TODO_LIST` in both Production and Preview.
6. Set these environment variables in both Production and Preview:

```sh
TODO_PIN=2468
TODO_SECRET=replace-with-a-long-random-string
```

The `wrangler.toml` file also declares `public` as the Pages output directory for Wrangler-based deploys. The KV namespace ID still has to be created in Cloudflare and bound as `TODO_LIST`.

Voice input uses browser speech recognition when supported. It does not use an OpenAI API key.

## Other internet access

If you host the local Node server somewhere else, use a real HTTPS layer in front of the app before sharing it outside your home network. Good options are a reverse proxy such as Caddy or nginx, or a tunnel such as Tailscale Funnel, Cloudflare Tunnel, or ngrok.

Keep `TODO_PIN` private and set a strong `TODO_SECRET`; the development fallback is only for trying the app locally.

## Storage

Todos are stored in `data/todos.json`. Backing up that file backs up the list.
