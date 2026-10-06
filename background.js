// Service worker (Manifest V3).
// 1) fetchText: busca uma URL com as permissões da extensão (sem CORS, com cookies).
// 2) renderAndExtract: plano B quando o fetch cai no desafio do Cloudflare ou quando o
//    HTML direto não serve. Abre a carta numa aba em segundo plano (reaproveitada entre
//    cartas) e devolve o HTML da página carregada.

let workerTabId = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    fetchText: () => fetchText(msg.url),
    renderAndExtract: () => renderAndExtract(msg.url),
    releaseWorkerTab: () => releaseWorkerTab(),
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler().then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true; // resposta assíncrona
});

async function fetchText(url) {
  const res = await fetch(url, { credentials: "include" });
  return { status: res.status, text: await res.text() };
}

async function getWorkerTab() {
  if (workerTabId != null) {
    try {
      await chrome.tabs.get(workerTabId);
      return workerTabId;
    } catch {
      workerTabId = null; // usuário fechou a aba
    }
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  workerTabId = tab.id;
  return workerTabId;
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done(true);
    }
    function done(ok) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Roda dentro da página da LigaMagic. Devolve o HTML completo: o <script> com o JSON
// de edições continua no DOM depois de executado.
async function readPricesInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && document.readyState !== "complete") {
    if (/just a moment/i.test(document.title)) return { status: "challenge" };
    await sleep(250);
  }
  if (/just a moment/i.test(document.title)) return { status: "challenge" };
  // A lista de ofertas pode ser montada por JavaScript depois do carregamento.
  const listingDeadline = Date.now() + 4000;
  while (Date.now() < listingDeadline && !document.querySelector("#marketplace-stores .store")) {
    await sleep(250);
  }
  return { status: "ok", html: document.documentElement.outerHTML };
}

async function inspect(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readPricesInPage,
    });
    return result?.result || { status: "notfound" };
  } catch {
    // A página navegou durante a leitura (ex.: o Cloudflare redirecionou).
    return { status: "navigating" };
  }
}

async function renderAndExtract(url) {
  const tabId = await getWorkerTab();
  await chrome.tabs.update(tabId, { url });
  await waitForComplete(tabId, 20000);

  let result = await inspect(tabId);
  // O desafio do Cloudflare às vezes se resolve sozinho e recarrega a página.
  for (let i = 0; i < 2 && (result.status === "challenge" || result.status === "navigating"); i++) {
    await waitForComplete(tabId, 12000);
    result = await inspect(tabId);
  }
  if (result.status === "navigating") result = { status: "notfound" };
  return result;
}

async function releaseWorkerTab() {
  if (workerTabId == null) return { ok: true };
  try {
    await chrome.tabs.remove(workerTabId);
  } catch {}
  workerTabId = null;
  return { ok: true };
}
