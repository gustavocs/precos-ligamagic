// Content script do Moxfield: lê o deck, busca preços na LigaMagic e mostra o painel.
// Funciona para qualquer formato; as regras do DC500 viraram opções do painel.
(() => {
  const L = LigaPrecos;
  // Preço encontrado vale até a virada do dia (a LigaMagic atualiza uma vez por dia).
  // Se a Liga atualizar mais tarde (ex.: às 3h), basta mudar rolloverHour.
  const CACHE_RULES = { rolloverHour: 0, missingTtlMs: 6 * 3600e3 }; // "não encontrada": 6h
  const REQUEST_GAP_MS = 900;      // intervalo entre requisições à LigaMagic
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const CRITERIA = { min: "Menor", medium: "Médio", max: "Maior" };
  const SORTS = { priceDesc: "Preço ↓", priceAsc: "Preço ↑", name: "Nome A–Z" };

  const state = {
    deckId: null, deck: null, prices: {}, phase: "idle",
    done: 0, todo: 0, error: null, runId: 0,
    restored: null, // { oldest, pending, stale } quando o painel veio do cache, sem buscar nada
  };
  let settings = {
    criterion: "min", limit: 500, collapsed: false, sort: "priceDesc",
    includeBasics: false, includeCommanders: false, includeSideboard: false,
    autoSync: false, // false = só busca preços ao clicar em "Buscar preços"
    pos: null,       // { h: "left"|"right", v: "top"|"bottom", x, y } — null = canto padrão
    size: null,      // { w, h } — null = tamanho automático
  };
  let overrides = {};
  let fetchMode = "fetch";   // "fetch" (HTML cru) ou "tab" (aba em segundo plano)

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parseHTML = (html) => new DOMParser().parseFromString(html, "text/html");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  // ---------- armazenamento ----------
  async function loadStored() {
    const s = await chrome.storage.local.get(["settings", "overrides"]);
    settings = { ...settings, ...(s.settings || {}) };
    overrides = s.overrides || {};
  }
  const saveSettings = () => chrome.storage.local.set({ settings });
  const saveOverrides = () => chrome.storage.local.set({ overrides });
  // "lm4:" = edição da oferta mais barata + JSON. Entradas de versões antigas são ignoradas.
  const cacheKey = (name) => "lm4:" + name.toLowerCase();

  async function cacheGet(name) {
    const key = cacheKey(name);
    const entry = (await chrome.storage.local.get(key))[key];
    if (!entry) return undefined;
    return L.isCacheFresh(entry, Date.now(), CACHE_RULES) ? entry : undefined;
  }
  const cacheSet = (name, prices) =>
    chrome.storage.local.set({ [cacheKey(name)]: { prices, ts: Date.now() } });

  // Lê o cache sem olhar a validade: para exibir o último preço conhecido.
  async function cacheRead(name) {
    const key = cacheKey(name);
    return (await chrome.storage.local.get(key))[key];
  }

  // Decks já buscados: guarda a lista de cartas para remontar o painel ao voltar ao deck
  // sem consultar nada. Mantém só os mais recentes.
  const DECK_PREFIX = "deck:", MAX_DECKS = 50;
  async function saveDeckSnapshot(id, deck) {
    await chrome.storage.local.set({ [DECK_PREFIX + id]: { deck, ts: Date.now() } });
    const all = await chrome.storage.local.get(null);
    const old = Object.keys(all).filter((k) => k.startsWith(DECK_PREFIX))
      .sort((a, b) => all[b].ts - all[a].ts).slice(MAX_DECKS);
    if (old.length) await chrome.storage.local.remove(old);
  }
  async function loadDeckSnapshot(id) {
    const key = DECK_PREFIX + id;
    return (await chrome.storage.local.get(key))[key]?.deck || null;
  }

  async function clearCache() {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((k) => /^lm\d*:/.test(k)));
  }

  // ---------- LigaMagic ----------
  // Edição da primeira oferta do marketplace + preço dessa edição no JSON.
  // Sem oferta listada: menor preço entre as edições. Sem JSON: blocos da página.
  const analyze = (html) => L.analyzeCardPage(html, parseHTML(html));
  let listingInRaw = null; // null = ainda não sabemos se a lista de ofertas vem no HTML cru

  async function fetchFromLiga(name) {
    const url = L.ligaUrl(name);

    if (fetchMode === "fetch") {
      const r = await send({ type: "fetchText", url });
      if (r && !r.error && r.status < 400 && !L.isChallengePage(r.text)) {
        const raw = analyze(r.text);
        if (raw.listingFound) {
          listingInRaw = true;
          return { status: "ok", prices: raw.prices };
        }
        if (listingInRaw === true) return { status: "ok", prices: raw.prices }; // carta sem ofertas
        // A lista de ofertas pode só existir depois do JavaScript: confere na aba.
        const t = await send({ type: "renderAndExtract", url });
        if (t?.status === "challenge") return { status: "challenge" };
        if (t?.status === "ok") {
          const rendered = analyze(t.html);
          if (rendered.listingFound) {
            listingInRaw = false;
            fetchMode = "tab"; // daqui em diante, direto pela aba
            return { status: "ok", prices: rendered.prices };
          }
        }
        return { status: "ok", prices: raw.prices };
      }
      fetchMode = "tab"; // Cloudflare bloqueou o fetch: daqui em diante, só aba
    }

    const r = await send({ type: "renderAndExtract", url });
    if (r?.error) throw new Error(r.error);
    if (r?.status === "challenge") return { status: "challenge" };
    if (r?.status === "ok") return { status: "ok", prices: analyze(r.html).prices };
    return { status: "ok", prices: null };
  }

  async function priceCard(card) {
    for (const lookup of card.lookups) {
      const cached = await cacheGet(lookup);
      if (cached) {
        if (cached.prices) return { status: "ok", prices: cached.prices, lookup };
        continue;
      }
      const res = await fetchFromLiga(lookup);
      await sleep(REQUEST_GAP_MS);
      if (res.status === "challenge") return res;
      await cacheSet(lookup, res.prices);
      if (res.prices) return { status: "ok", prices: res.prices, lookup };
    }
    return { status: "notfound", prices: null, lookup: card.lookups[0] };
  }

  // Mesmo caminho de priceCard, mas só com o que está guardado (mesmo vencido).
  // undefined = algum nome nunca foi buscado.
  async function priceCardFromCache(card) {
    let ts = Infinity;
    for (const lookup of card.lookups) {
      const cached = await cacheRead(lookup);
      if (!cached) return undefined;
      ts = Math.min(ts, cached.ts);
      if (cached.prices) return { status: "ok", prices: cached.prices, lookup, ts };
    }
    return { status: "notfound", prices: null, lookup: card.lookups[0], ts };
  }

  // Volta a um deck já buscado: deck e preços saem do armazenamento, sem rede.
  async function restore() {
    const runId = state.runId;
    const deck = await loadDeckSnapshot(state.deckId);
    if (!deck || runId !== state.runId) return;
    const prices = {};
    let oldest = Infinity, pending = 0, stale = 0;
    const now = Date.now();
    for (const card of deck.cards) {
      if (!L.isPriced(card, settings) || prices[card.name]) continue;
      const res = await priceCardFromCache(card);
      if (!res) { pending++; continue; }
      prices[card.name] = res;
      oldest = Math.min(oldest, res.ts);
      if (!L.isCacheFresh(res, now, CACHE_RULES)) stale++;
    }
    if (runId !== state.runId) return;
    Object.assign(state, {
      deck, prices, phase: "done",
      restored: { oldest: Number.isFinite(oldest) ? oldest : null, pending, stale },
    });
    render();
  }

  // ---------- fluxo principal ----------
  async function run() {
    const runId = ++state.runId;
    Object.assign(state, { error: null, prices: {}, phase: "deck", done: 0, todo: 0, restored: null });
    render();

    try {
      const r = await send({ type: "fetchText", url: L.moxfieldDeckApi(state.deckId) });
      if (r?.error) throw new Error(r.error);
      if (r.status >= 400) {
        throw new Error(`O Moxfield respondeu ${r.status}. Decks privados ainda não são suportados.`);
      }
      if (runId !== state.runId) return;
      state.deck = L.flattenDeck(JSON.parse(r.text));
      saveDeckSnapshot(state.deckId, state.deck);
    } catch (e) {
      if (runId !== state.runId) return;
      Object.assign(state, { phase: "error", error: `Não foi possível ler o deck. ${e.message}` });
      render();
      return;
    }
    priceMissing();
  }

  // Busca o preço das cartas que entram na conta e ainda não têm preço.
  // Chamada de novo quando uma opção passa a contar mais cartas (ex.: sideboard).
  let pricing = false, pricingAgain = false;

  async function priceMissing() {
    if (pricing) { pricingAgain = true; return; }
    pricing = true;
    try {
      do {
        pricingAgain = false;
        const runId = state.runId;
        if (!state.deck) break;
        const byName = new Map();
        for (const c of state.deck.cards) {
          if (L.isPriced(c, settings) && !state.prices[c.name] && !byName.has(c.name)) byName.set(c.name, c);
        }
        // O que entra no total primeiro; sideboard e comandante (só consulta) depois.
        const queue = [...byName.values()].sort((a, b) => L.isCounted(b, settings) - L.isCounted(a, settings));
        if (!queue.length) break;
        Object.assign(state, { done: 0, todo: queue.length, phase: "prices", restored: null });
        render();

        for (const card of queue) {
          if (runId !== state.runId) { pricingAgain = true; break; }
          let res;
          try {
            res = await priceCard(card);
          } catch (e) {
            res = { status: "error", prices: null, lookup: card.lookups[0], error: e.message };
          }
          if (runId !== state.runId) { pricingAgain = true; break; }
          if (res.status === "challenge") {
            state.phase = "challenge";
            render();
            return;
          }
          state.prices[card.name] = res;
          state.done++;
          render();
        }
      } while (pricingAgain);
      if (state.deck && state.phase !== "error") {
        state.phase = "done";
        render();
      }
    } finally {
      pricing = false;
      send({ type: "releaseWorkerTab" });
    }
  }

  function effectivePrices() {
    const merged = { ...state.prices };
    for (const [name, value] of Object.entries(overrides)) {
      merged[name] = {
        status: "manual",
        lookup: state.prices[name]?.lookup || name,
        prices: { min: value, medium: value, max: value },
      };
    }
    return merged;
  }

  // ---------- painel ----------
  let host, shadow;

  const isLoading = () => state.phase === "deck" || state.phase === "prices";

  function mount() {
    host = document.createElement("div");
    host.id = "precos-ligamagic";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${CSS}</style><section class="panel" aria-label="Preços LigaMagic"></section>`;
    shadow.addEventListener("click", swallowClickAfterDrag, true);
    shadow.addEventListener("click", onClick);
    shadow.addEventListener("change", onChange);
    shadow.addEventListener("pointerdown", onPointerDown);
    shadow.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("resize", () => drag || applyLayout());
    document.documentElement.appendChild(host);
  }

  // ---------- posição e tamanho ----------
  // O painel fica preso ao canto mais próximo (left/right + top/bottom), então cresce
  // para longe da borda. Perto da borda, encaixa na margem padrão.
  const MARGIN = 16, SNAP = 40, MIN_W = 364, MIN_H = 260;
  const DEFAULT_POS = { h: "right", v: "bottom", x: MARGIN, y: MARGIN };
  const viewW = () => document.documentElement.clientWidth;
  const viewH = () => document.documentElement.clientHeight;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, Math.max(lo, hi)));
  let drag = null, suppressClick = false;

  function applyLayout() {
    const panel = shadow?.querySelector(".panel");
    if (!panel) return;
    const pos = settings.pos || DEFAULT_POS;
    const size = !settings.collapsed && settings.size;
    const s = panel.style;
    s.width = size?.w ? `${Math.min(size.w, viewW() - 2 * 8)}px` : "";
    s.height = size?.h ? `${Math.min(size.h, viewH() - 2 * 8)}px` : "";
    panel.classList.toggle("sized", !!size?.h);
    panel.dataset.h = pos.h;
    panel.dataset.v = pos.v;
    // Mantém o painel visível mesmo se a janela encolheu.
    s.left = s.right = s.top = s.bottom = "";
    s[pos.h] = `${clamp(pos.x, 0, viewW() - panel.offsetWidth)}px`;
    s[pos.v] = `${clamp(pos.y, 0, viewH() - panel.offsetHeight)}px`;
  }

  function anchorFor(r) {
    const h = r.left + r.width / 2 < viewW() / 2 ? "left" : "right";
    const v = r.top + r.height / 2 < viewH() / 2 ? "top" : "bottom";
    let x = Math.round(h === "left" ? r.left : viewW() - r.right);
    let y = Math.round(v === "top" ? r.top : viewH() - r.bottom);
    if (x < SNAP) x = MARGIN;
    if (y < SNAP) y = MARGIN;
    return { h, v, x, y };
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const handle = e.target.closest("[data-drag], [data-resize]");
    if (!handle) return;
    // Botões e campos dentro do cabeçalho continuam clicáveis.
    const control = e.target.closest("button, select, input, a, label");
    if (control && control !== handle) return;
    const panel = shadow.querySelector(".panel");
    drag = {
      mode: "resize" in handle.dataset ? "resize" : "move",
      x0: e.clientX, y0: e.clientY, moved: false,
      rect: panel.getBoundingClientRect(),
      pos: settings.pos || DEFAULT_POS,
    };
    e.preventDefault(); // evita seleção de texto
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
  }

  function onPointerMove(e) {
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const panel = shadow.querySelector(".panel");
    const r = drag.rect;
    if (drag.mode === "move") {
      Object.assign(panel.style, {
        left: `${clamp(r.left + dx, 0, viewW() - r.width)}px`,
        top: `${clamp(r.top + dy, 0, viewH() - r.height)}px`,
        right: "", bottom: "",
      });
      panel.classList.add("dragging");
    } else {
      // A alça fica no canto livre: arrastar para fora da borda presa aumenta o painel.
      const w = r.width + (drag.pos.h === "right" ? -dx : dx);
      const h = r.height + (drag.pos.v === "bottom" ? -dy : dy);
      panel.style.width = `${clamp(w, MIN_W, viewW() - 2 * 8)}px`;
      panel.style.height = `${clamp(h, MIN_H, viewH() - 2 * 8)}px`;
      panel.classList.add("sized");
    }
  }

  function onPointerUp() {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
    const panel = shadow.querySelector(".panel");
    panel.classList.remove("dragging");
    if (drag.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      const r = panel.getBoundingClientRect();
      if (drag.mode === "move") settings.pos = anchorFor(r);
      else settings.size = { w: Math.round(r.width), h: Math.round(r.height) };
      saveSettings();
    }
    drag = null;
    applyLayout();
  }

  // Soltar o painel depois de arrastar não deve contar como clique (ex.: na pílula).
  function swallowClickAfterDrag(e) {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }

  // Duplo clique no cabeçalho: volta ao canto e ao tamanho padrão.
  function onDoubleClick(e) {
    const handle = e.target.closest("header[data-drag]");
    if (!handle || e.target.closest("button")) return;
    settings.pos = null;
    settings.size = null;
    saveSettings();
    applyLayout();
  }

  function statusLine(missing) {
    switch (state.phase) {
      case "deck": return "Lendo o deck no Moxfield…";
      case "prices": {
        const via = fetchMode === "tab" ? " (via aba em segundo plano)" : "";
        return `Buscando preços na LigaMagic: ${state.done} de ${state.todo}${via}`;
      }
      case "challenge":
        return `A LigaMagic pediu uma verificação de segurança. <a href="https://www.ligamagic.com.br/" target="_blank" rel="noopener">Abra a LigaMagic</a>, conclua a verificação e clique em Recalcular.`;
      case "error": return esc(state.error);
      case "done":
        if (state.restored) return restoredLine(missing);
        return missing
          ? `${missing} ${missing === 1 ? "carta ficou" : "cartas ficaram"} sem preço. Use ✎ para informar o valor manualmente.`
          : "Todos os preços encontrados.";
      default: return "";
    }
  }

  function ago(ts) {
    const min = Math.round((Date.now() - ts) / 60e3);
    if (min < 2) return "agora há pouco";
    if (min < 60) return `há ${min} min`;
    const h = Math.round(min / 60);
    if (h < 48) return `há ${h} h`;
    return `há ${Math.round(h / 24)} dias`;
  }

  function restoredLine(missing) {
    const { oldest, pending, stale } = state.restored;
    const parts = [];
    if (!stale && !pending) parts.push("Preços de hoje, já guardados.");
    else if (stale) parts.push(`Preços guardados, buscados ${ago(oldest)}. Já virou o dia desde então.`);
    if (pending) parts.push(`${pending} ${pending === 1 ? "carta ainda não tem preço" : "cartas ainda não têm preço"}.`);
    if (missing) parts.push(`${missing} sem preço na LigaMagic.`);
    if (stale || pending) parts.push("Clique em Recalcular para atualizar.");
    return parts.join(" ");
  }

  function priceHint(pr) {
    if (pr.note) return pr.note;
    if (pr.source === "listing") {
      let hint = `Edição da oferta mais barata na Liga: ${pr.listingEdition}`;
      if (pr.allMin != null && pr.allMin < pr.min - 0.005) {
        hint += `. O resumo da página indicava ${brl.format(pr.allMin)} em ${pr.allMinEdition}, valor que não aparece nas ofertas.`;
      }
      return hint;
    }
    return "";
  }

  const BOARD_TAGS = { commander: "comandante", side: "sideboard", companion: "companheiro" };

  function checkbox(key, label) {
    return `
        <label class="check">
          <input data-setting="${key}" type="checkbox" ${settings[key] ? "checked" : ""}>
          ${label}
        </label>`;
  }

  function render() {
    if (!host) return;
    renderPanel();
    if (!drag) applyLayout(); // durante o arraste, a posição é controlada pelo ponteiro
  }

  const HEADER = `
      <header data-drag title="Arraste para mover. Duplo clique volta ao canto padrão.">
        <h2>Preços LigaMagic</h2>
        <button class="icon" data-action="toggle" title="Recolher" aria-label="Recolher painel">–</button>
      </header>`;
  const GRIP = `<div class="grip" data-resize title="Arraste para redimensionar" aria-hidden="true"></div>`;

  // O painel tem quatro telas: pílula (recolhido), aguardando, carregando e completa.
  // A estrutura de cada tela é montada só quando a tela (ou o deck) muda; depois disso,
  // cada render atualiza apenas o que mudou: total, barra, status, progresso e lista.
  // Controles nunca são recriados no meio do uso, então foco e texto digitado ficam.
  let view = null, viewDeck = null;
  const $ = (sel) => shadow.querySelector(sel);

  function renderPanel() {
    host.style.display = state.deckId ? "" : "none";
    const panel = $(".panel");
    const loading = isLoading();
    const idle = state.phase === "idle";
    const next = settings.collapsed ? "pill" : idle ? "idle" : loading ? "loading" : "full";
    if (next !== view || (next === "full" && viewDeck !== state.deck)) {
      panel.innerHTML = SKELETONS[next]();
      view = next;
      viewDeck = state.deck;
    }
    const merged = effectivePrices();
    const totals = L.computeTotal(state.deck?.cards || [], merged, settings);
    const limit = Number(settings.limit) || 0; // 0 = sem limite
    panel.classList.toggle("over", limit > 0 && totals.total > limit);
    panel.classList.toggle("collapsed", !!settings.collapsed);
    // Telas curtas (aguardando, carregando) ignoram a altura escolhida pelo usuário.
    panel.classList.toggle("compact", loading || idle);
    UPDATES[next]?.(merged, totals, limit);
  }

  // Só mostra as opções que fazem sentido para este deck.
  function deckOptions(deck) {
    return [
      deck?.hasCommanders ? checkbox("includeCommanders", "Contar comandante") : "",
      deck?.hasSideboard ? checkbox("includeSideboard", "Contar sideboard") : "",
      deck?.hasBasics ? checkbox("includeBasics", "Contar básicos") : "",
    ].join("");
  }

  const selectOf = (key, entries) => `
          <select data-setting="${key}">
            ${Object.entries(entries).map(([k, label]) =>
              `<option value="${k}" ${settings[key] === k ? "selected" : ""}>${label}</option>`).join("")}
          </select>`;

  const SKELETONS = {
    pill: () => `
        <button class="pill" data-action="toggle" data-drag title="Abrir painel de preços (arraste para mover)">
          <span>Liga</span><strong></strong>
        </button>`,

    // Deck aberto, mas a busca só começa quando o usuário pedir.
    idle: () => `
      ${HEADER}
      <div class="idle-view">
        <p>Os preços deste deck ainda não foram buscados.</p>
        <button class="primary" data-action="refresh">Buscar preços</button>
        <div class="idle-options">${checkbox("autoSync", "Buscar sozinho ao abrir um deck")}</div>
      </div>`,

    // Enquanto busca, o painel fica travado: só o progresso. O resto aparece ao terminar.
    loading: () => `
      ${HEADER}
      <div class="loading-view" role="status" aria-live="polite">
        <p class="loading-message"></p>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-fill"></div>
        </div>
        <p class="note"></p>
      </div>`,

    full: () => `
      ${HEADER}
      <div class="total"></div>
      <div class="budget">
        <div class="meter" role="meter" aria-valuemin="0"><div class="fill"></div></div>
        <p class="balance"></p>
      </div>
      <p class="status"></p>
      <div class="controls">
        <label>Preço ${selectOf("criterion", CRITERIA)}</label>
        <label title="Deixe vazio para não usar limite">Limite R$
          <input data-setting="limit" type="number" min="0" step="10" placeholder="sem" value="${Number(settings.limit) || ""}">
        </label>
        ${deckOptions(state.deck)}
        ${checkbox("autoSync", "Buscar ao abrir decks")}
      </div>
      <div class="actions">
        <button data-action="refresh">Recalcular</button>
        <button data-action="clear" class="quiet">Limpar cache</button>
        <label class="sort">Ordenar ${selectOf("sort", SORTS)}</label>
      </div>
      <ul class="list"></ul>
      ${GRIP}`,
  };

  const UPDATES = {
    pill(_merged, { total }) {
      const idle = state.phase === "idle";
      const el = $(".pill strong");
      el.textContent = idle ? "buscar"
        : !isLoading() ? brl.format(total)
        : state.phase === "deck" ? "…" : `${state.done}/${state.todo}`;
      el.classList.toggle("muted", idle);
    },

    loading() {
      const pct = state.todo ? Math.round((state.done / state.todo) * 100) : 0;
      $(".loading-message").textContent = state.phase === "deck"
        ? "Lendo o deck no Moxfield…"
        : `Buscando preços na LigaMagic: ${state.done} de ${state.todo}`;
      $(".progress").setAttribute("aria-valuenow", pct);
      $(".progress-fill").style.width = `${pct}%`;
      const via = fetchMode === "tab" ? "Usando uma aba em segundo plano, que fecha sozinha. " : "";
      $(".loading-view .note").textContent = `${via}O total e a lista aparecem quando todos os preços chegarem.`;
    },

    full(merged, { total, missing }, limit) {
      $(".total").textContent = brl.format(total);

      const budget = $(".budget");
      budget.hidden = !(limit > 0);
      if (limit > 0) {
        const over = total > limit;
        const meter = $(".meter");
        meter.setAttribute("aria-valuemax", limit);
        meter.setAttribute("aria-valuenow", total);
        $(".fill").style.width = `${Math.min(total / limit, 1) * 100}%`;
        $(".balance").textContent = over
          ? `Passou ${brl.format(total - limit)} do limite de ${brl.format(limit)}`
          : `Sobram ${brl.format(limit - total)} do limite de ${brl.format(limit)}`;
      }

      const status = $(".status");
      status.classList.toggle("alert", state.phase === "challenge" || state.phase === "error");
      status.innerHTML = statusLine(missing);

      // A lista é a única parte redesenhada por inteiro: ordem e etiquetas mudam a cada preço.
      const list = $(".list");
      const scrollTop = list.scrollTop;
      list.innerHTML = listRows(merged, total, limit);
      list.scrollTop = scrollTop;
    },
  };

  function listRows(merged, total, limit) {
    const cards = state.deck?.cards || [];
    const value = (c) => merged[c.name]?.prices?.[settings.criterion];
    // Ordenação: nas opções por preço, o que conta no total vem primeiro, depois cartas
    // sem preço, depois as fora do total; na alfabética, só o nome.
    const lineValue = (c) => (value(c) ?? 0) * c.quantity;
    const group = (c) => !L.isPriced(c, settings) ? 3
      : !L.isCounted(c, settings) ? 2
      : value(c) == null ? 1 : 0;
    const byName = (a, b) => a.name.localeCompare(b.name, "pt-BR");
    const sorters = {
      priceDesc: (a, b) => group(a) - group(b) || lineValue(b) - lineValue(a) || byName(a, b),
      priceAsc: (a, b) => group(a) - group(b) || lineValue(a) - lineValue(b) || byName(a, b),
      name: byName,
    };
    const remaining = limit > 0 ? limit - total : null;

    // Etiqueta de troca para cartas do sideboard que não entram no total.
    function swapTag(c, v) {
      if (remaining == null || c.board !== "side" || L.isCounted(c, settings) || v == null) return "";
      const need = v * c.quantity - remaining;
      if (need <= 0.005) {
        return `<span class="tag swap-tag fits" title="Cabe no orçamento trocando por qualquer carta do deck">cabe</span>`;
      }
      return `<span class="tag swap-tag" title="Para caber no orçamento, a carta do deck que sai precisa custar ${brl.format(need)} ou mais">sai ≥ ${brl.format(need)}</span>`;
    }

    const row = (c) => {
      const p = merged[c.name];
      const v = value(c);
      const counted = L.isCounted(c, settings);
      const priced = L.isPriced(c, settings);
      let price;
      if (!priced) price = `<span class="muted">fora da conta</span>`;
      else if (!p) price = state.restored
        ? `<span class="muted" title="Ainda não buscado. Clique em Recalcular.">—</span>`
        : `<span class="muted">…</span>`;
      else if (v == null) price = `<span class="warn">sem preço</span>`;
      else {
        const hint = priceHint(p.prices) + (counted ? "" : (priceHint(p.prices) ? ". " : "") + "Não entra no total.");
        price = `<span title="${esc(hint)}">${brl.format(v * c.quantity)}</span>`;
      }
      const tags = [
        c.board === "commander" || c.board === "companion"
          ? `<span class="tag board-tag">${BOARD_TAGS[c.board]}</span>` : "",
        p?.status === "manual"
          ? `<span class="tag" title="Preço informado manualmente">manual</span>`
          : p?.prices?.check && priced
            ? `<span class="tag warn-tag" title="${esc(p.prices.note || "")}">conferir</span>`
            : "",
      ].join("");
      return `
          <li class="${counted ? "" : "excluded"}">
            <span class="qty">${c.quantity}</span>
            <span class="name-cell">
              <a class="name" href="${L.ligaUrl(p?.lookup || c.lookups[0])}" target="_blank" rel="noopener" title="Ver na LigaMagic">${esc(c.name)}</a>${tags}${swapTag(c, v)}
            </span>
            <span class="price">${price}</span>
            <button class="edit" data-action="edit" data-name="${esc(c.name)}" title="Definir preço manual" aria-label="Definir preço manual para ${esc(c.name)}">✎</button>
          </li>`;
    };

    const sorted = [...cards].sort(sorters[settings.sort] || sorters.priceDesc);
    const deckRows = sorted.filter((c) => c.board !== "side").map(row).join("");
    const sideCards = sorted.filter((c) => c.board === "side");
    const sideSection = sideCards.length
      ? `<li class="section">${settings.includeSideboard ? "Sideboard" : "Sideboard, fora do total"}</li>${sideCards.map(row).join("")}`
      : "";
    return deckRows + sideSection;
  }

  function onClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "toggle") {
      settings.collapsed = !settings.collapsed;
      saveSettings();
      render();
    } else if (action === "refresh") {
      run();
    } else if (action === "clear") {
      clearCache().then(run);
    } else if (action === "edit") {
      const name = btn.dataset.name;
      const current = overrides[name] != null ? String(overrides[name]).replace(".", ",") : "";
      const input = prompt(`Preço manual por unidade de ${name} (R$).\nDeixe vazio para voltar a usar a LigaMagic.`, current);
      if (input === null) return;
      const parsed = parseFloat(input.replace(/\./g, "").replace(",", "."));
      if (input.trim() === "" || isNaN(parsed)) delete overrides[name];
      else overrides[name] = parsed;
      saveOverrides();
      render();
    }
  }

  function onChange(e) {
    const key = e.target.dataset.setting;
    if (!key) return;
    if (e.target.type === "checkbox") settings[key] = e.target.checked;
    else if (key === "limit") settings.limit = Math.max(0, Number(e.target.value) || 0);
    else settings[key] = e.target.value;
    saveSettings();
    render();
    // Contar comandante/sideboard/básicos pode exigir preços que ainda não foram buscados.
    if (key.startsWith("include")) priceMissing();
  }

  // ---------- navegação (o Moxfield é uma SPA) ----------
  function checkLocation() {
    const id = L.deckIdFromPath(location.pathname);
    if (id === state.deckId) return;
    state.deckId = id;
    state.runId++; // cancela a busca do deck anterior
    Object.assign(state, { deck: null, prices: {}, error: null, phase: "idle", restored: null });
    render();
    if (!id) return;
    // Por padrão não busca nada sozinho: espera o clique em "Buscar preços".
    // Deck já buscado antes volta direto do armazenamento, sem consultar nada.
    if (settings.autoSync) run();
    else restore();
  }

  const CSS = `
    :host { all: initial; }
    .panel {
      --bg: #1c2230; --surface: #262d3d; --line: #343c50; --text: #e8eaf0;
      --muted: #98a0b3; --gold: #e0b340; --over: #ef6b6b;
      /* left/right/top/bottom vêm de applyLayout() */
      position: fixed; z-index: 2147483000;
      width: 364px; max-height: 72vh; display: flex; flex-direction: column;
      background: var(--bg); color: var(--text); border: 1px solid var(--line);
      border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.45);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: 14px 14px 8px; box-sizing: border-box;
    }
    .panel.collapsed { width: auto; padding: 0; border-radius: 999px; }
    .panel.sized { max-height: none; overflow: hidden; }
    .panel.sized .list { flex: 1 1 0; min-height: 0; }
    .panel.compact { height: auto !important; }
    .panel.dragging { opacity: .92; box-shadow: 0 16px 40px rgba(0,0,0,.55); }
    header { display: flex; align-items: center; justify-content: space-between; }
    header[data-drag] {
      cursor: grab; user-select: none; touch-action: none;
      margin: -14px -14px 0; padding: 14px 14px 4px; /* área de arraste até a borda */
    }
    .dragging header[data-drag], .dragging .pill { cursor: grabbing; }
    .grip {
      position: absolute; width: 14px; height: 14px; touch-action: none;
      background: linear-gradient(135deg, transparent 0 50%, var(--muted) 50% 58%,
        transparent 58% 70%, var(--muted) 70% 78%, transparent 78%);
      opacity: .6;
    }
    .grip:hover { opacity: 1; }
    /* A alça fica no canto oposto ao canto onde o painel está preso. */
    .panel[data-h=left][data-v=top] .grip { right: 2px; bottom: 2px; cursor: nwse-resize; }
    .panel[data-h=right][data-v=top] .grip { left: 2px; bottom: 2px; cursor: nesw-resize; transform: scaleX(-1); }
    .panel[data-h=left][data-v=bottom] .grip { right: 2px; top: 2px; cursor: nesw-resize; transform: scaleY(-1); }
    .panel[data-h=right][data-v=bottom] .grip { left: 2px; top: 2px; cursor: nwse-resize; transform: rotate(180deg); }
    .idle-view { padding: 10px 0 6px; }
    .idle-view p { margin: 0 0 12px; }
    .idle-options { margin-top: 12px; }
    button.primary { background: var(--gold); color: #1c2230; border-color: var(--gold); font-weight: 600; padding: 7px 14px; }
    button.primary:hover { filter: brightness(1.08); }
    h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--muted); }
    .total {
      font-size: 34px; font-weight: 700; letter-spacing: -0.02em; margin: 6px 0 8px;
      font-variant-numeric: tabular-nums; color: var(--gold);
    }
    .over .total { color: var(--over); }
    .loading-view { padding: 10px 0 8px; }
    .loading-message { margin: 0 0 10px; font-size: 15px; font-variant-numeric: tabular-nums; }
    .progress { height: 6px; background: var(--surface); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; background: var(--muted); transition: width .25s ease; }
    @media (prefers-reduced-motion: reduce) { .progress-fill { transition: none; } }
    .meter { height: 8px; background: var(--surface); border-radius: 4px; overflow: hidden; }
    .fill { height: 100%; background: var(--gold); transition: width .3s ease; }
    .over .fill { background: var(--over); }
    @media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
    .balance { margin: 6px 0 0; color: var(--muted); font-variant-numeric: tabular-nums; }
    .status { margin: 10px 0 0; }
    .status.alert { color: var(--over); }
    .status a, .note a { color: var(--gold); }
    .note { margin: 6px 0 0; color: var(--muted); }
    .controls { display: flex; flex-wrap: wrap; gap: 8px 12px; margin-top: 12px; align-items: center; }
    label { display: flex; align-items: center; gap: 6px; color: var(--muted); }
    select, input[type=number] {
      background: var(--surface); color: var(--text); border: 1px solid var(--line);
      border-radius: 6px; padding: 3px 6px; font: inherit;
    }
    input[type=number] { width: 64px; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 12px 0 8px; font-size: 12px; }
    .actions button { padding: 5px 9px; }
    .actions .sort { margin-left: auto; gap: 4px; }
    button {
      font: inherit; color: var(--text); background: var(--surface);
      border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer;
    }
    button:hover { border-color: var(--muted); }
    button:focus-visible, a:focus-visible, select:focus-visible, input:focus-visible {
      outline: 2px solid var(--gold); outline-offset: 2px;
    }
    button.quiet { background: transparent; color: var(--muted); }
    button.icon { background: transparent; border: none; color: var(--muted); font-size: 18px; padding: 0 4px; line-height: 1; }
    .pill { display: flex; gap: 10px; align-items: baseline; border-radius: 999px; padding: 8px 14px; background: var(--bg); border: none; touch-action: none; }
    .pill span { color: var(--muted); }
    .pill strong { color: var(--gold); font-variant-numeric: tabular-nums; }
    .pill strong.muted { color: var(--muted); font-weight: 500; }
    .over .pill strong { color: var(--over); }
    .list { list-style: none; margin: 0 -14px; padding: 0 14px; overflow-y: auto; border-top: 1px solid var(--line); }
    .list li {
      display: grid; grid-template-columns: 22px 1fr auto auto; gap: 6px; align-items: center;
      padding: 5px 0; border-bottom: 1px solid var(--surface);
    }
    .list li.excluded { opacity: .55; }
    .list li.section {
      display: block; padding: 12px 0 4px; border-bottom: 1px solid var(--line);
      color: var(--muted); font-weight: 600;
    }
    .swap-tag { color: var(--text); border-color: var(--muted); white-space: nowrap; }
    .swap-tag.fits { color: var(--gold); border-color: var(--gold); }
    .qty { color: var(--muted); font-variant-numeric: tabular-nums; }
    .name-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .name { color: var(--text); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .name:hover { text-decoration: underline; }
    .price { font-variant-numeric: tabular-nums; text-align: right; }
    .tag { flex-shrink: 0; font-size: 11px; color: var(--gold); border: 1px solid var(--gold); border-radius: 4px; padding: 0 4px; }
    .warn-tag { color: var(--over); border-color: var(--over); }
    .board-tag { color: var(--muted); border-color: var(--line); flex-shrink: 0; }
    .muted { color: var(--muted); }
    .warn { color: var(--over); }
    .edit { background: transparent; border: none; color: var(--muted); padding: 0 2px; }
  `;

  // ---------- início ----------
  loadStored().then(() => {
    mount();
    checkLocation();
    setInterval(checkLocation, 1000);
  });
})();
