# NonStop Proxy — ImovelUm

Proxy que fica entre o site e a API da NonStop. Esconde o token, resolve CORS e cacheia.

## Deploy na Render (passo a passo)

1. **Suba esta pasta num repositório GitHub** (ex.: `nonstop-proxy`).
2. Acesse **render.com** → **New +** → **Web Service**.
3. Conecte o repositório `nonstop-proxy`.
4. Configure:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Em **Environment**, adicione as variáveis (aba "Environment"):

| Variável           | Valor                                                        | Obrigatória |
|--------------------|-------------------------------------------------------------|-------------|
| `NONSTOP_TOKEN`    | *(seu token Bearer da NonStop — cole aqui, não no código)*   | ✅ |
| `NONSTOP_SLUG`     | *(slug do corretor/imobiliária, ex.: `imovelum`)*            | ⭐ recomendada |
| `ALLOWED_ORIGINS`  | `https://imovelumpremier.com.br,https://imovelum.com.br`     | ⭐ recomendada |

6. Clique em **Deploy Web Service** e aguarde 2-3 min até aparecer **Live**.

## Testar

Depois do deploy, abra no navegador (troque pela URL do seu serviço):

- `https://SEU-SERVICO.onrender.com/status` → deve responder `{"status":"online"}`
- `https://SEU-SERVICO.onrender.com/api/destaques?limit=6` → deve trazer imóveis (JSON)

> ⚠️ No plano Free, o serviço hiberna após inatividade. A primeira chamada pode
> levar 30-50s pra "acordar". Depois responde normal.

## Rotas

| Rota                       | Método | O que faz                                   |
|----------------------------|--------|---------------------------------------------|
| `/status`                  | GET    | Healthcheck                                 |
| `/api/destaques?limit=12`  | GET    | Seleção curada de imóveis (carrega o site)  |
| `/api/imoveis?...`         | GET    | Busca completa com filtros                  |
| `/api/imovel/:id`          | GET    | Ficha individual                            |
| `/api/localidades?...`     | GET    | Autocomplete cidade/bairro                  |
| `/api/lead`                | POST   | Captura de lead → dispara WhatsApp NonStop  |
| `/sitemap.xml`             | GET    | Sitemap gerado das URLs                     |

## Notas importantes (pegadinhas conhecidas)

- **Coordenadas GeoJSON** vêm como `[lng, lat]` — inverta pra `[lat, lng]` no Google Maps.
- **Transação**: busca usa `VENDA`/`LOCACAO`, mas o **lead** usa `SELL`/`RENT`.
- **listingId** do lead: formato `slug#base36Id`.
- Nomes de campo na resposta podem variar; ajustar conforme o retorno real do `/api/destaques`.
