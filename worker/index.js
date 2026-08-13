// Cloudflare Worker: serves the built static site (via the Assets
// binding) and adds a password-gated API for a small library of
// screenplays stored in KV. No per-user accounts — one shared
// password (set as a secret) protects the whole script library.
//
// Each script is stored under key `script:<id>` as a JSON blob, with
// KV metadata {title, updatedAt} attached so the list endpoint can
// build a picker without fetching every script's full body.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    // Everything else: serve the static built site.
    return env.ASSETS.fetch(request);
  },
};

function checkPassword(request, env) {
  const provided = request.headers.get("X-App-Password") || "";
  // env.APP_PASSWORD is set via `wrangler secret put APP_PASSWORD`
  return env.APP_PASSWORD && provided === env.APP_PASSWORD;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Password",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const authed = checkPassword(request, env);

  if (url.pathname === "/api/login" && request.method === "POST") {
    return json({ ok: authed }, authed ? 200 : 401);
  }

  if (!authed) {
    return json({ error: "unauthorized" }, 401);
  }

  const parts = url.pathname.split("/").filter(Boolean); // ["api", "scripts", ":id"?]

  // GET /api/scripts — list all scripts (title + last-updated only)
  if (parts.length === 2 && parts[1] === "scripts" && request.method === "GET") {
    const list = await env.SCRIPTS_KV.list({ prefix: "script:" });
    const scripts = list.keys.map((k) => ({
      id: k.name.slice("script:".length),
      title: (k.metadata && k.metadata.title) || "Untitled Screenplay",
      updatedAt: (k.metadata && k.metadata.updatedAt) || null,
    }));
    scripts.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return json({ scripts });
  }

  // POST /api/scripts — create a new blank script, return its full data
  if (parts.length === 2 && parts[1] === "scripts" && request.method === "POST") {
    const id = crypto.randomUUID();
    const savedAt = new Date().toISOString();
    const data = { id, title: "Untitled Screenplay", author: "", blocks: [], elements: [], savedAt };
    await env.SCRIPTS_KV.put(`script:${id}`, JSON.stringify(data), {
      metadata: { title: data.title, updatedAt: savedAt },
    });
    return json(data);
  }

  // GET / PUT / DELETE /api/scripts/:id
  if (parts.length === 3 && parts[1] === "scripts") {
    const id = parts[2];
    const key = `script:${id}`;

    if (request.method === "GET") {
      const data = await env.SCRIPTS_KV.get(key);
      if (!data) return json({ error: "not found" }, 404);
      return new Response(data, { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }

    if (request.method === "PUT") {
      const body = await request.text();
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        return json({ error: "invalid json" }, 400);
      }
      const updatedAt = parsed.savedAt || new Date().toISOString();
      await env.SCRIPTS_KV.put(key, body, {
        metadata: { title: parsed.title || "Untitled Screenplay", updatedAt },
      });
      return json({ ok: true });
    }

    if (request.method === "DELETE") {
      await env.SCRIPTS_KV.delete(key);
      return json({ ok: true });
    }
  }

  return json({ error: "not found" }, 404);
}
