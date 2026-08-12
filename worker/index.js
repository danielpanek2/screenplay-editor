// Cloudflare Worker: serves the built static site (via the Assets
// binding) and adds a small password-gated API backed by KV for
// cloud-syncing the screenplay. No per-user accounts — one shared
// password (set as a secret) protects one shared script slot.

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
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Password",
};

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

  if (url.pathname === "/api/script" && request.method === "GET") {
    const data = await env.SCRIPTS_KV.get("current_script");
    return new Response(data || "null", {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  if (url.pathname === "/api/script" && request.method === "PUT") {
    const body = await request.text();
    await env.SCRIPTS_KV.put("current_script", body);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
