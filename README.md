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

## Netlify

This project is Netlify-ready. It publishes `public/`, routes `/api/*` to a Netlify Function, and stores shopping items in Netlify Blobs.

Set these environment variables in Netlify before sharing the site:

```sh
TODO_PIN=2468
TODO_SECRET=replace-with-a-long-random-string
OPENAI_API_KEY=sk-...
```

Netlify will install `@netlify/blobs` during the deploy.

Voice input uses the OpenAI transcription API through the Netlify Function. The API key must stay in Netlify environment variables; do not put it in browser code.

## Other internet access

If you host the local Node server somewhere else, use a real HTTPS layer in front of the app before sharing it outside your home network. Good options are a reverse proxy such as Caddy or nginx, or a tunnel such as Tailscale Funnel, Cloudflare Tunnel, or ngrok.

Keep `TODO_PIN` private and set a strong `TODO_SECRET`; the development fallback is only for trying the app locally.

## Storage

Todos are stored in `data/todos.json`. Backing up that file backs up the list.
