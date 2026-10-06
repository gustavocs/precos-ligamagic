// Content script do Moxfield: lê o deck, busca preços na LigaMagic e mostra o painel.
// Funciona para qualquer formato; as regras do DC500 viraram opções do painel.
(() => {
  const L = LigaPrecos;
  const TTL_FOUND = 24 * 3600e3;   // preço encontrado vale 24h
  const TTL_MISSING = 6 * 3600e3;  // "não encontrada" vale 6h
  const REQUEST_GAP_MS = 900;      // intervalo entre requisições à LigaMagic
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const CRITERIA = { min: "Menor", medium: "Médio", max: "Maior" };
  const SORTS = { priceDesc: "Maior preço", priceAsc: "Menor preço", name: "Nome (A–Z)" };

  const state = {
    deckId: null, deck: null, prices: {}, phase: "idle",
    done: 0, todo: 0, error: null, runId: 0,
  };
  let settings = {
    criterion: "min", limit: 500, collapsed: false, sort: "priceDesc",
    includeBasics: false, includeCommanders: false, includeSideboard: false,
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
    const ttl = entry.prices ? TTL_FOUND : TTL_MISSING;
    return Date.now() - entry.ts < ttl ? entry : undefined;
  }
  const cacheSet = (name, prices) =>
    chrome.storage.local.set({ [cacheKey(name)]: { prices, ts: Date.now() } });

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

  // ---------- fluxo principal ----------
  async function run() {
    const runId = ++state.runId;
    Object.assign(state, { error: null, prices: {}, phase: "deck", done: 0, todo: 0 });
    render();

    try {
      const r = await send({ type: "fetchText", url: L.moxfieldDeckApi(state.deckId) });
      if (r?.error) throw new Error(r.error);
      if (r.status >= 400) {
        throw new Error(`O Moxfield respondeu ${r.status}. Decks privados ainda não são suportados.`);
      }
      if (runId !== state.runId) return;
      state.deck = L.flattenDeck(JSON.parse(r.text));
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
        Object.assign(state, { done: 0, todo: queue.length, phase: "prices" });
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
    shadow.addEventListener("click", onClick);
    shadow.addEventListener("change", onChange);
    document.documentElement.appendChild(host);
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
        return missing
          ? `${missing} ${missing === 1 ? "carta ficou" : "cartas ficaram"} sem preço. Use ✎ para informar o valor manualmente.`
          : "Todos os preços encontrados.";
      default: return "";
    }
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
    host.style.display = state.deckId ? "" : "none";
    const panel = shadow.querySelector(".panel");
    const deck = state.deck;
    const cards = deck?.cards || [];
    const merged = effectivePrices();
    const { total, missing } = L.computeTotal(cards, merged, settings);
    const limit = Number(settings.limit) || 0; // 0 = sem limite
    const over = limit > 0 && total > limit;

    const loading = isLoading();
    panel.classList.toggle("over", over);
    panel.classList.toggle("collapsed", !!settings.collapsed);

    if (settings.collapsed) {
      const pillValue = !loading ? brl.format(total)
        : state.phase === "deck" ? "…" : `${state.done}/${state.todo}`;
      panel.innerHTML = `
        <button class="pill" data-action="toggle" title="Abrir painel de preços">
          <span>Liga</span><strong>${pillValue}</strong>
        </button>`;
      return;
    }

    // Enquanto busca, o painel fica travado: só o progresso. O resto aparece ao terminar.
    if (loading) {
      const pct = state.todo ? Math.round((state.done / state.todo) * 100) : 0;
      const message = state.phase === "deck"
        ? "Lendo o deck no Moxfield…"
        : `Buscando preços na LigaMagic: ${state.done} de ${state.todo}`;
      const via = fetchMode === "tab" ? "Usando uma aba em segundo plano, que fecha sozinha. " : "";
      panel.innerHTML = `
      <header>
        <h2>Preços LigaMagic</h2>
        <button class="icon" data-action="toggle" title="Recolher" aria-label="Recolher painel">–</button>
      </header>
      <div class="loading-view" role="status" aria-live="polite">
        <p class="loading-message">${message}</p>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <p class="note">${via}O total e a lista aparecem quando todos os preços chegarem.</p>
      </div>`;
      return;
    }

    let budget = "";
    if (limit > 0) {
      const fill = Math.min(total / limit, 1) * 100;
      const balance = over
        ? `Passou ${brl.format(total - limit)} do limite de ${brl.format(limit)}`
        : `Sobram ${brl.format(limit - total)} do limite de ${brl.format(limit)}`;
      budget = `
      <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${total}">
        <div class="fill" style="width:${fill}%"></div>
      </div>
      <p class="balance">${balance}</p>`;
    }

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
      else if (!p) price = `<span class="muted">…</span>`;
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
    const rows = deckRows + sideSection;

    // Só mostra as opções que fazem sentido para este deck.
    const options = [
      deck?.hasCommanders ? checkbox("includeCommanders", "Contar comandante") : "",
      deck?.hasSideboard ? checkbox("includeSideboard", "Contar sideboard") : "",
      deck?.hasBasics ? checkbox("includeBasics", "Contar básicos") : "",
    ].join("");

    // Preserva rolagem da lista e o campo em edição: o painel é redesenhado a cada preço.
    const prevList = panel.querySelector(".list");
    const scrollTop = prevList ? prevList.scrollTop : 0;
    const active = shadow.activeElement;
    const activeKey = active?.dataset?.setting;
    const draft = activeKey === "limit" ? active.value : null;

    panel.innerHTML = `
      <header>
        <h2>Preços LigaMagic</h2>
        <button class="icon" data-action="toggle" title="Recolher" aria-label="Recolher painel">–</button>
      </header>
      <div class="total">${brl.format(total)}</div>
      ${budget}
      <p class="status ${state.phase === "challenge" || state.phase === "error" ? "alert" : ""}">${statusLine(missing)}</p>
      <div class="controls">
        <label>Preço
          <select data-setting="criterion">
            ${Object.entries(CRITERIA).map(([k, label]) =>
              `<option value="${k}" ${settings.criterion === k ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <label title="Deixe vazio para não usar limite">Limite R$
          <input data-setting="limit" type="number" min="0" step="10" placeholder="sem" value="${limit || ""}">
        </label>
        ${options}
        <label>Ordenar
          <select data-setting="sort">
            ${Object.entries(SORTS).map(([k, label]) =>
              `<option value="${k}" ${settings.sort === k ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="actions">
        <button data-action="refresh">Recalcular</button>
        <button data-action="clear" class="quiet">Limpar cache</button>
      </div>
      <ul class="list">${rows}</ul>`;

    const list = panel.querySelector(".list");
    if (list) list.scrollTop = scrollTop;
    if (activeKey) {
      const el = panel.querySelector(`[data-setting="${activeKey}"]`);
      if (el) {
        if (draft != null) el.value = draft;
        el.focus({ preventScroll: true });
      }
    }
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
    priceMissing(); // uma opção pode ter passado a contar cartas sem preço
  }

  // ---------- navegação (o Moxfield é uma SPA) ----------
  function checkLocation() {
    const id = L.deckIdFromPath(location.pathname);
    if (id === state.deckId) return;
    state.deckId = id;
    state.runId++; // cancela a busca do deck anterior
    state.deck = null;
    render();
    if (id) run();
  }

  const CSS = `
    :host { all: initial; }
    .panel {
      --bg: #1c2230; --surface: #262d3d; --line: #343c50; --text: #e8eaf0;
      --muted: #98a0b3; --gold: #e0b340; --over: #ef6b6b;
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      width: 340px; max-height: 72vh; display: flex; flex-direction: column;
      background: var(--bg); color: var(--text); border: 1px solid var(--line);
      border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.45);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: 14px 14px 8px; box-sizing: border-box;
    }
    .panel.collapsed { width: auto; padding: 0; border-radius: 999px; }
    header { display: flex; align-items: center; justify-content: space-between; }
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
    .actions { display: flex; gap: 8px; margin: 12px 0 8px; }
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
    .pill { display: flex; gap: 10px; align-items: baseline; border-radius: 999px; padding: 8px 14px; background: var(--bg); border: none; }
    .pill span { color: var(--muted); }
    .pill strong { color: var(--gold); font-variant-numeric: tabular-nums; }
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
