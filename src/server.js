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

// ===========================================================================
// CURADORIA PREMIER — critério de posicionamento do site
// Só entram imóveis à VENDA, em bairros nobres selecionados, a partir de R$ 1mi.
// ===========================================================================
const PREMIER_MIN_SALE = 1_000_000;

// 18 bairros nobres de São Paulo (o "andar de cima" do mercado)
const PREMIER_BAIRROS = [
  "Jardim América",
  "Jardim Europa",
  "Jardim Paulista",
  "Jardim Paulistano",
  "Moema",
  "Vila Nova Conceição",
  "Itaim Bibi",
  "Vila Olímpia",
  "Cerqueira César",
  "Pinheiros",
  "Alto de Pinheiros",
  "Brooklin",
  "Campo Belo",
  "Cidade Jardim",
  "Perdizes",
  "Paraíso",
  "Vila Mariana",
  "Vila Madalena",
];

// Normaliza: sem acento, minúsculo, sem espaços extras.
// Faz "Vila Olímpia" == "VILA OLIMPIA" == "vila  olimpia".
function normalize(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
const PREMIER_BAIRROS_NORM = new Set(PREMIER_BAIRROS.map(normalize));

// Um imóvel passa na curadoria Premier?
function isPremier(imovel) {
  const bairro = normalize(imovel?.address?.area);
  if (!PREMIER_BAIRROS_NORM.has(bairro)) return false; // bairro fora da lista
  const sale = Number(imovel?.values?.sale);
  if (!sale || sale < PREMIER_MIN_SALE) return false; // sem venda ou abaixo de 1mi
  return true;
}

// Remove dados sensíveis dos corretores/brokerage antes de servir ao front.
// O site nunca deve expor email, telefone, WhatsApp, Stripe etc.
function sanitize(imovel) {
  if (!imovel || typeof imovel !== "object") return imovel;
  const clean = { ...imovel };
  delete clean.user;        // dados do corretor
  delete clean.brokerage;   // dados de assinatura/pagamento
  delete clean.network;
  return clean;
}

// ---------------------------------------------------------------------------
// Healthcheck
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => res.json({ status: "online", service: "nonstop-proxy" }));
app.get("/status", (_req, res) => res.json({ status: "online", slug: SLUG || null }));

// ---------------------------------------------------------------------------
// PREMIER — o acervo curado do site (bairros nobres, venda ≥ R$ 1mi)
// Puxa o acervo do site no NonStop e aplica o filtro de posicionamento.
// ---------------------------------------------------------------------------
app.get("/api/premier", async (req, res) => {
  try {
    // Busca uma boa quantidade pra ter margem antes de filtrar.
    const perPage = Number(req.query.perPage) || 100;
    const currentPage = Number(req.query.currentPage) || 1;
    const q = new URLSearchParams({
      availableFor: "VENDA",
      currentPage,
      perPage,
      sortBy: "sale",
      sortOrder: -1, // mais caros primeiro
      search: "",
    }).toString();

    const raw = await nonstop(`/imoveis/todos?${q}`, { cacheTtl: 5 * 60 * 1000 });

    // A resposta pode vir como array direto ou dentro de um campo (data/imoveis/results).
    const lista = Array.isArray(raw)
      ? raw
      : raw?.data || raw?.imoveis || raw?.results || raw?.items || [];

    const premier = lista.filter(isPremier).map(sanitize);

    res.json({
      total: premier.length,
      criterio: { bairros: PREMIER_BAIRROS.length, minVenda: PREMIER_MIN_SALE },
      imoveis: premier,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// DESTAQUES — a seleção curada que carrega o site
// Ajuste os filtros conforme o critério que você escolher depois.
// ---------------------------------------------------------------------------
app.get("/api/destaques", async (req, res) => {
  try {
    // limite padrão de 12; sobrescreve com ?limit=
    const limit = Number(req.query.limit) || 12;
    // Rota /imoveis/home: retorna os imóveis marcados com a tag "Home"
    // no painel de integrações do NonStop. availableFor opcional (VENDA/LOCACAO).
    const availableFor = req.query.availableFor
      ? `&availablefor=${req.query.availableFor}`
      : "";
    const data = await nonstop(
      `/imoveis/home?limit=${limit}${availableFor}`,
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
    // /imoveis/todos exige availableFor, currentPage, perPage, sortBy, sortOrder e search.
    // Preenche defaults sensatos se o front não mandar.
    const q = {
      availableFor: req.query.availableFor || "VENDA",
      currentPage: req.query.currentPage || 1,
      perPage: req.query.perPage || 12,
      sortBy: req.query.sortBy || "_id",
      sortOrder: req.query.sortOrder || 1,
      search: req.query.search || "",
      ...req.query,
    };
    const qs = new URLSearchParams(q).toString();
    const data = await nonstop(`/imoveis/todos?${qs}`, { cacheTtl: 2 * 60 * 1000 });
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
    const data = await nonstop(`/imoveis/${req.params.id}`, {
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
app.get("/api/cidades", async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const data = await nonstop(`/imoveis/cidades?${qs}`, { cacheTtl: 60 * 60 * 1000 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/bairros", async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const data = await nonstop(`/imoveis/bairros?${qs}`, { cacheTtl: 60 * 60 * 1000 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/estados", async (req, res) => {
  try {
    const data = await nonstop(`/imoveis/estados`, { cacheTtl: 6 * 60 * 60 * 1000 });
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
    const {
      name,
      email,
      phone,
      whatsapp,
      message,
      propertyId,
      transactionType = "SELL", // SELL | RENT
      origin = "SITE",
    } = req.body || {};

    if (!name || !phone) {
      return res.status(400).json({ error: "name e phone são obrigatórios" });
    }

    // listingId no formato [slug]#[base36Id]. Precisa do NONSTOP_SLUG configurado.
    const listingId =
      propertyId && SLUG ? `${SLUG}#${propertyId}` : propertyId || null;

    const payload = {
      listingId,
      origin,                       // "SITE"
      name: name || null,
      phone: phone || null,
      whatsapp: whatsapp || phone || null,
      email: email || null,
      message: message || null,
      transactionType,              // "SELL" | "RENT"
    };

    const data = await nonstop(`/leads/criar`, { method: "POST", body: payload });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// SITEMAP
// ---------------------------------------------------------------------------
// Contato (telefone, whatsapp, creci, redes) configurado no perfil NonStop
app.get("/api/contato", async (_req, res) => {
  try {
    const data = await nonstop(`/site/contato`, { cacheTtl: 6 * 60 * 60 * 1000 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/sitemap.xml", async (_req, res) => {
  try {
    const slug = SLUG || "";
    const data = await nonstop(`/site/urls?slug=${slug}`, {
      cacheTtl: 6 * 60 * 60 * 1000,
    });
    const urls = Array.isArray(data) ? data : [];
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
