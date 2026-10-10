// Lógica pura, sem dependência de chrome.* — testável fora do navegador.
// Carregado antes de content.js (ver manifest.json).

var LigaPrecos = (() => {
  const LIGA_CARD_URL = "https://www.ligamagic.com.br/?view=cards/card&card=";

  // "R$ 1.234,56" -> 1234.56
  function parseBRL(text) {
    if (!text) return null;
    const m = String(text).replace(/\s+/g, " ").match(/R\$\s*([\d.]*\d,\d{2})/);
    if (!m) return null;
    return parseFloat(m[1].replace(/\./g, "").replace(",", "."));
  }

  // ---------- Fonte principal: JSON de edições embutido no HTML ----------
  // A página da carta traz, num <script>, um array com todas as edições, ex.:
  //   [{"name":"Urza's Legacy","code":"ul",...,
  //     "price":{"0":{"p":"49.89","m":"98.00","g":"119.99"},"2":{"p":"699.99",...}}},
  //    {"name":"Duel Decks: Elspeth vs. Kiora",...,"price":[{"p":"59.99","m":"78.33","g":"109.90"}]}]
  // p = menor, m = médio, g = maior. Cada chave/item de "price" é uma variante (normal, foil...).

  // Recorta um literal [...] balanceado a partir de s[start] === "[", respeitando strings.
  function sliceBalanced(s, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  }

  const isPriceTable = (v) =>
    v && typeof v === "object" &&
    Object.values(v).some((x) => x && typeof x === "object" && ("p" in x || "m" in x || "g" in x));

  function findEditions(html) {
    const re = /=\s*\[\s*\{/g;
    let m;
    while ((m = re.exec(html || ""))) {
      const start = html.indexOf("[", m.index);
      const chunk = sliceBalanced(html, start);
      if (!chunk) continue;
      re.lastIndex = start + chunk.length;
      if (!chunk.includes('"price"')) continue;
      try {
        const arr = JSON.parse(chunk);
        if (Array.isArray(arr) && arr.some((e) => e && isPriceTable(e.price))) return arr;
      } catch {}
    }
    return null;
  }

  // Para cada critério, o menor valor entre todas as edições e variantes.
  function pricesFromEditions(editionsList) {
    const num = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const best = { min: null, medium: null, max: null };
    let editions = 0, cheapestEdition = null;
    for (const ed of editionsList) {
      let hasOffer = false;
      for (const v of Object.values(ed?.price || {})) {
        const p = { min: num(v?.p), medium: num(v?.m), max: num(v?.g) };
        if (p.min == null && p.medium == null && p.max == null) continue;
        hasOffer = true;
        for (const k of ["min", "medium", "max"]) {
          if (p[k] != null && (best[k] == null || p[k] < best[k])) {
            best[k] = p[k];
            if (k === "min") cheapestEdition = ed.name || ed.code || null;
          }
        }
      }
      if (hasOffer) editions++;
    }
    return editions ? { ...best, editions, cheapestEdition } : null;
  }

  function pricesFromHTML(html) {
    const list = findEditions(html);
    return list ? pricesFromEditions(list) : null;
  }

  // ---------- Primeira oferta do marketplace (a mais barata da Liga) ----------
  // O preço da oferta é ofuscado (sprite), mas a edição é texto. Extrai as pistas:
  //   data-tooltip="sticky_479760_13"  -> idkey
  //   href="...card=ed=mh1"            -> code
  //   <div class="name-ed">Modern Horizons</div> -> name
  function firstListingEdition(root) {
    const store = root.querySelector("#marketplace-stores .store, #marketplace-stores [id^='mpline_']");
    if (!store) return null;
    const tooltip = store.querySelector("[data-tooltip^='sticky_']")?.getAttribute("data-tooltip");
    const zoom = store.querySelector("[onclick*='zoom(']")?.getAttribute("onclick")?.match(/zoom\('([^']+)'\)/);
    const href = store.querySelector(".name-ed a")?.getAttribute("href") || "";
    return {
      idkey: tooltip ? tooltip.replace(/^sticky_/, "") : zoom ? zoom[1] : null,
      code: (href.match(/ed=([\w-]+)/) || [])[1]?.toLowerCase() || null,
      name: store.querySelector(".name-ed")?.textContent.trim() || null,
    };
  }

  function matchEdition(editionsList, key) {
    const norm = (s) => (s || "").trim().toLowerCase();
    return (
      (key.idkey && editionsList.find((e) => e.idkey === key.idkey)) ||
      (key.code && editionsList.find((e) => norm(e.code) === key.code)) ||
      (key.name && editionsList.find((e) => norm(e.name) === norm(key.name))) ||
      null
    );
  }

  // Combina tudo para uma página de carta. root = Document já parseado do mesmo html.
  // Devolve { prices, listingFound } — prices traz source e, se for o caso, check/note.
  function analyzeCardPage(html, root) {
    const editionsList = findEditions(html);
    const listing = firstListingEdition(root);
    if (!editionsList) {
      const fromPage = extractPrices(root);
      return {
        listingFound: !!listing,
        prices: fromPage && { ...fromPage, source: "page", check: true,
          note: "Só a edição exibida na página foi considerada. Confira na LigaMagic." },
      };
    }
    const all = pricesFromEditions(editionsList);
    const summary = all && { allMin: all.min, allMinEdition: all.cheapestEdition, editions: all.editions };
    if (listing) {
      const ed = matchEdition(editionsList, listing);
      const own = ed && pricesFromEditions([ed]);
      if (own) {
        return { listingFound: true,
          prices: { min: own.min, medium: own.medium, max: own.max, source: "listing",
                    listingEdition: ed.name || listing.name, ...summary } };
      }
      return { listingFound: true,
        prices: all && { ...all, ...summary, source: "editions", check: true,
          note: `A oferta mais barata é de "${listing.name || listing.code}", mas essa edição não foi encontrada nos dados da página. Usando o menor preço entre as edições.` } };
    }
    return { listingFound: false,
      prices: all && { ...all, ...summary, source: "editions", check: true,
        note: "Nenhuma oferta listada na página. Usando o resumo de preços das edições." } };
  }

  // ---------- Fallback: blocos desenhados na página ----------
  // ATENÇÃO: só refletem a edição exibida no momento (variantes normal/foil),
  // não todas as edições. Usado apenas se o JSON não for encontrado.
  // <div class="price-mkp"><div class="min"><div class="price">R$ 46,76</div></div>...</div>
  function extractPrices(root) {
    const lower = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
    let best = null;
    for (const block of root.querySelectorAll(".price-mkp")) {
      const get = (cls) => parseBRL(block.querySelector(`.${cls} .price`)?.textContent);
      const p = { min: get("min"), medium: get("medium"), max: get("max") };
      if (p.min == null && p.medium == null && p.max == null) continue;
      best = best
        ? { min: lower(best.min, p.min), medium: lower(best.medium, p.medium), max: lower(best.max, p.max) }
        : p;
    }
    return best;
  }

  function isChallengePage(html) {
    return /<title>\s*Just a moment|challenge-platform|cf-chl-/i.test(html || "");
  }

  function ligaUrl(name) {
    return LIGA_CARD_URL + encodeURIComponent(name);
  }

  // Moxfield: /decks/{publicId}. Ignora páginas de listagem (/decks/personal etc.).
  function deckIdFromPath(pathname) {
    const m = pathname.match(/^\/decks\/([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : null;
  }

  function moxfieldDeckApi(deckId) {
    return `https://api2.moxfield.com/v3/decks/all/${deckId}`;
  }

  // Nomes a tentar na LigaMagic, em ordem.
  // Ainda não confirmado como a Liga nomeia dupla-face/split, então há fallback.
  function lookupNames(card) {
    const name = card.name;
    if (!name.includes(" // ")) return [name];
    const front = name.split(" // ")[0];
    if (card.layout === "split" || card.layout === "aftermath") return [name, front];
    return [front, name]; // transform, modal_dfc, adventure, flip...
  }

  function isBasicLand(card) {
    return /\bBasic\b/.test(card.type_line || "") && /\bLand\b/.test(card.type_line || "");
  }

  // ---------- Validade do cache ----------
  // A LigaMagic atualiza os preços uma vez por dia, então o preço guardado vale até a
  // próxima virada do dia (horário de Brasília), não por um número fixo de horas.
  // rolloverHour permite mover a virada (ex.: 3 = o "dia" da Liga começa às 3h).
  const BRT_DAY = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  });

  // "2026-10-09": o dia de preços ao qual o instante ts pertence.
  function priceDay(ts, rolloverHour = 0) {
    return BRT_DAY.format(new Date(ts - rolloverHour * 3600e3));
  }

  // Entrada do cache { prices, ts } ainda vale? "Não encontrada" vence antes (missingTtlMs),
  // porque pode ter sido um erro passageiro.
  function isCacheFresh(entry, now, { rolloverHour = 0, missingTtlMs = 6 * 3600e3 } = {}) {
    if (!entry) return false;
    if (priceDay(entry.ts, rolloverHour) !== priceDay(now, rolloverHour)) return false;
    return entry.prices ? true : now - entry.ts < missingTtlMs;
  }

  // Boards do Moxfield que a extensão considera (maybeboard e afins ficam de fora).
  const BOARDS = { mainboard: "main", companions: "companion", commanders: "commander", sideboard: "side" };

  // JSON do Moxfield -> lista de cartas, uma entrada por (board, nome).
  function flattenDeck(json) {
    const byKey = new Map();
    for (const [boardName, board] of Object.entries(BOARDS)) {
      for (const entry of Object.values(json?.boards?.[boardName]?.cards || {})) {
        const card = entry.card;
        if (!card) continue;
        const key = `${board}:${card.name}`;
        const prev = byKey.get(key);
        if (prev) {
          prev.quantity += entry.quantity;
          continue;
        }
        byKey.set(key, {
          key, board,
          name: card.name,
          quantity: entry.quantity,
          isBasic: isBasicLand(card),
          lookups: lookupNames(card),
        });
      }
    }
    const cards = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
    return {
      name: json?.name || "",
      cards,
      hasCommanders: cards.some((c) => c.board === "commander"),
      hasSideboard: cards.some((c) => c.board === "side"),
      hasBasics: cards.some((c) => c.isBasic),
    };
  }

  // Se a carta entra na soma, de acordo com as opções do painel.
  function isCounted(card, { includeBasics, includeCommanders, includeSideboard }) {
    if (card.isBasic && !includeBasics) return false;
    if (card.board === "commander") return !!includeCommanders;
    if (card.board === "side") return !!includeSideboard;
    return true; // mainboard e companheiro
  }

  // Se a carta tem o preço buscado: tudo que conta, mais sideboard e comandante
  // (mostrados para consulta, mesmo fora do total). Básicos só se contarem.
  function isPriced(card, settings) {
    return isCounted(card, settings) || card.board === "side" || card.board === "commander";
  }

  // Soma o deck. prices: { [cardName]: { status, prices } }
  function computeTotal(cards, prices, settings) {
    const { criterion } = settings;
    let total = 0, missing = 0, pending = 0;
    for (const c of cards) {
      if (!isCounted(c, settings)) continue;
      const p = prices[c.name];
      if (!p) { pending++; continue; }
      const v = p.prices?.[criterion];
      if (v == null) { missing++; continue; }
      total += v * c.quantity;
    }
    return { total: Math.round(total * 100) / 100, missing, pending };
  }

  return {
    parseBRL, pricesFromHTML, findEditions, pricesFromEditions, extractPrices,
    firstListingEdition, matchEdition, analyzeCardPage, isChallengePage, ligaUrl,
    deckIdFromPath, moxfieldDeckApi, lookupNames, isBasicLand,
    flattenDeck, isCounted, isPriced, computeTotal, priceDay, isCacheFresh,
  };
})();

if (typeof module !== "undefined") module.exports = LigaPrecos;
