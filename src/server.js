// ============================================================================
// NonStop Proxy — ImovelUm
// ----------------------------------------------------------------------------
// Fica entre o front (site / LP / Extranet) e a API da NonStop.
// Resolve 3 coisas de uma vez:
//   1. Esconde o Bearer token (NUNCA vai pro navegador)
//   2. Mata o CORS
//   3. Dá um lugar pra cachear o que muda pouco
//
//        Browser  →  (sem token)  →  ESTE PROXY (Render)  →  (Bearer)  →  NonStop
//
// Deploy: Render (Web Service, Node). Variáveis de ambiente:
//   NONSTOP_TOKEN    (obrigatória) — token Bearer da NonStop
//   NONSTOP_SLUG     (recomendada) — slug do corretor/imobiliária p/ montar listingId do lead
//   ALLOWED_ORIGINS  (recomendada) — domínios liberados, separados por vírgula
//                                     ex: https://imovelumpremier.com.br,https://imovelum.com.br
//   PORT             (a Render injeta automaticamente)
// ============================================================================

import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const NONSTOP_BASE = "https://www.usenonstop.com/api/unstable";
const TOKEN = process.env.NONSTOP_TOKEN;
const SLUG = process.env.NONSTOP_SLUG || null;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
  console.error("[FATAL] NONSTOP_TOKEN não definido. Configure nas env vars da Render.");
  process.exit(1);
}

// CORS — só libera os domínios listados (em dev, libera tudo se a lista estiver vazia)
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);            // curl / postman / SSR
      if (ALLOWED.length === 0) return cb(null, true); // dev
      return cb(null, ALLOWED.includes(origin));
    },
  })
);

// ---------------------------------------------------------------------------
// Cache em memória (TTL por chave). Para listas que mudam pouco.
// ---------------------------------------------------------------------------
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

// ---------------------------------------------------------------------------
// Helper central: chama a NonStop injetando o Bearer
// ---------------------------------------------------------------------------
async function nonstop(path, { method = "GET", body, cacheTtl = 0 } = {}) {
  const cacheKey = method === "GET" ? `${method}:${path}` : null;
  if (cacheKey && cacheTtl > 0) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  const res = await fetch(`${NONSTOP_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NonStop ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  if (cacheKey && cacheTtl > 0) cacheSet(cacheKey, data, cacheTtl);
  return data;
}

// ---------------------------------------------------------------------------
// Healthcheck
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => res.json({ status: "online", service: "nonstop-proxy" }));
app.get("/status", (_req, res) => res.json({ status: "online", slug: SLUG || null }));

// ---------------------------------------------------------------------------
// DESTAQUES — a seleção curada que carrega o site
// Ajuste os filtros conforme o critério que você escolher depois.
// ---------------------------------------------------------------------------
app.get("/api/destaques", async (req, res) => {
  try {
    // limite padrão de 12; sobrescreve com ?limit=
    const limit = Number(req.query.limit) || 12;
    // Estratégia simples: busca imóveis à venda, ordenados, e corta no limite.
    // Depois trocamos por um filtro de "featured" real quando definirmos o critério.
    const data = await nonstop(
      `/properties?transaction=VENDA&perPage=${limit}&page=1`,
      { cacheTtl: 10 * 60 * 1000 } // 10 min
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// BUSCA completa (filtros livres via querystring)
// ---------------------------------------------------------------------------
app.get("/api/imoveis", async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const data = await nonstop(`/properties?${qs}`, { cacheTtl: 2 * 60 * 1000 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// FICHA individual
// ---------------------------------------------------------------------------
app.get("/api/imovel/:id", async (req, res) => {
  try {
    const data = await nonstop(`/properties/${req.params.id}`, {
      cacheTtl: 5 * 60 * 1000,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// AUTOCOMPLETE cidade / bairro
// ---------------------------------------------------------------------------
app.get("/api/localidades", async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const data = await nonstop(`/locations?${qs}`, { cacheTtl: 60 * 60 * 1000 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// CAPTURA DE LEAD
// PEGADINHA: o lead usa SELL/RENT (não VENDA/LOCACAO da busca).
// PEGADINHA: listingId no formato  [slug]#[base36Id]
// ---------------------------------------------------------------------------
app.post("/api/lead", async (req, res) => {
  try {
    const { name, email, phone, message, propertyId, transaction = "SELL" } = req.body || {};
    if (!name || !phone) {
      return res.status(400).json({ error: "name e phone são obrigatórios" });
    }

    const listingId =
      propertyId && SLUG ? `${SLUG}#${propertyId}` : propertyId || null;

    const payload = {
      name,
      email: email || null,
      phone,
      message: message || null,
      transaction, // SELL | RENT
      listingId,
    };

    const data = await nonstop(`/leads`, { method: "POST", body: payload });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// SITEMAP
// ---------------------------------------------------------------------------
app.get("/sitemap.xml", async (_req, res) => {
  try {
    const data = await nonstop(`/site/urls`, { cacheTtl: 6 * 60 * 60 * 1000 });
    const urls = Array.isArray(data?.urls) ? data.urls : [];
    const body = urls
      .map((u) => `  <url><loc>${u}</loc></url>`)
      .join("\n");
    res.set("Content-Type", "application/xml");
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`NonStop proxy rodando na porta ${PORT}`));
