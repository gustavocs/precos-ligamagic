// Testes da lógica pura (lib.js). Rodar com: npm install && npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const L = require("../lib.js");

const doc = (html) => new JSDOM(html).window.document;

// Estrutura observada na página de carta da LigaMagic (out/2026), reduzida.
const editionsScript = (mh1key = "479760_13") => `<script>
var outra = [{"x":"texto com [colchete] e \\"aspas\\""}];
var cards_editions = [
 {"id":1,"idkey":"900_1","name":"Commander Legends","code":"cmr","img":"\\/\\/repo\\/a.jpg","price":{"0":{"p":"20.00","m":"30.00","g":"40.00"}}},
 {"id":2,"idkey":"${mh1key}","name":"Modern Horizons","code":"mh1","price":{"0":{"p":"38.50","m":"45.00","g":"60.00"},"2":{"p":"90.00","m":"110.00","g":"150.00"}}},
 {"id":3,"idkey":"246_21","name":"Commander","code":"cmd","price":[]}];
var cards_stock = [{"id":33358568,"idEdicao":"2","lj_id":22101}];
</script>`;

const listing = `<div id="marketplace-stores">
 <div class="store" id="mpline_1_33358568">
  <div class="container-zoom-card" onclick="editionsCard.zoom('479760_13');"></div>
  <div class="title" data-tooltip="sticky_479760_13"><div class="name-ed">
   <a href="/?view=cards/search&amp;card=ed=mh1">Modern Horizons</a></div></div>
  <div class="new-price price-with-image"><div class="imgnum-monet">R$</div><div class="pKrEq fPpRw aRcMp">&nbsp;</div></div>
 </div>
</div>`;

const analyze = (html) => L.analyzeCardPage(html, doc(html));

test("parseBRL", () => {
  assert.equal(L.parseBRL("R$ 46,76"), 46.76);
  assert.equal(L.parseBRL("R$ 1.234,56"), 1234.56);
  assert.equal(L.parseBRL("R$0,25"), 0.25);
  assert.equal(L.parseBRL("--"), null);
});

test("JSON de edições: menor valor por critério entre edições e variantes", () => {
  const r = L.pricesFromHTML(editionsScript());
  assert.deepEqual(r, { min: 20, medium: 30, max: 40, editions: 2, cheapestEdition: "Commander Legends" });
});

test("JSON de edições ausente", () => {
  assert.equal(L.pricesFromHTML("<html><p>nada</p></html>"), null);
});

test("primeira oferta: casa a edição pelo idkey", () => {
  const r = analyze(editionsScript() + listing);
  assert.equal(r.listingFound, true);
  assert.equal(r.prices.source, "listing");
  assert.equal(r.prices.min, 38.5);
  assert.equal(r.prices.listingEdition, "Modern Horizons");
  assert.equal(r.prices.allMin, 20);
});

test("primeira oferta: cai para o código da edição se o idkey não bater", () => {
  const r = analyze(editionsScript("000_0") + listing);
  assert.equal(r.prices.source, "listing");
  assert.equal(r.prices.min, 38.5);
});

test("sem oferta listada: menor entre edições, marcado para conferir", () => {
  const r = analyze(editionsScript());
  assert.equal(r.listingFound, false);
  assert.equal(r.prices.min, 20);
  assert.equal(r.prices.check, true);
});

test("edição da oferta fora do JSON: menor entre edições, marcado para conferir", () => {
  const html = editionsScript().replace('"code":"mh1"', '"code":"zzz"').replace('"name":"Modern Horizons"', '"name":"MH"')
    .replace('"idkey":"479760_13"', '"idkey":"x"') + listing;
  const r = analyze(html);
  assert.equal(r.listingFound, true);
  assert.equal(r.prices.min, 20);
  assert.equal(r.prices.check, true);
});

test("sem JSON: usa os blocos da página como parcial", () => {
  const html = `<div class="price-mkp"><div class="min"><div class="price">R$ 46,76</div></div>
    <div class="medium"><div class="price">R$ 56,96</div></div><div class="max"><div class="price">R$ 64,90</div></div></div>`;
  const r = analyze(html);
  assert.equal(r.prices.min, 46.76);
  assert.equal(r.prices.source, "page");
  assert.equal(r.prices.check, true);
});

test("página de desafio do Cloudflare", () => {
  assert.equal(L.isChallengePage("<title>Just a moment...</title>"), true);
  assert.equal(L.isChallengePage("<title>Mother of Runes | LigaMagic</title>"), false);
});

test("id do deck a partir da URL do Moxfield", () => {
  assert.equal(L.deckIdFromPath("/decks/oEWXWHM5eEGMmopExLWRCA"), "oEWXWHM5eEGMmopExLWRCA");
  assert.equal(L.deckIdFromPath("/decks/personal"), null);
});

test("nomes de busca para dupla-face e split", () => {
  assert.deepEqual(L.lookupNames({ name: "Legion's Landing // Adanto, the First Fort", layout: "transform" }),
    ["Legion's Landing", "Legion's Landing // Adanto, the First Fort"]);
  assert.deepEqual(L.lookupNames({ name: "Fire // Ice", layout: "split" }), ["Fire // Ice", "Fire"]);
});

test("cache vence na virada do dia (horário de Brasília), não em 24h", () => {
  const t = (iso) => Date.parse(iso);
  const found = (iso) => ({ prices: { min: 1 }, ts: t(iso) });
  // 23h48 de Brasília = 02h48 UTC do dia seguinte
  assert.equal(L.priceDay(t("2026-10-10T02:48:00Z")), "2026-10-09");
  assert.equal(L.isCacheFresh(found("2026-10-10T02:48:00Z"), t("2026-10-10T02:59:00Z")), true);  // 23h59
  assert.equal(L.isCacheFresh(found("2026-10-10T02:48:00Z"), t("2026-10-10T03:10:00Z")), false); // 0h10
  // buscado às 8h, ainda vale às 23h do mesmo dia
  assert.equal(L.isCacheFresh(found("2026-10-09T11:00:00Z"), t("2026-10-10T02:00:00Z")), true);
  // com a virada às 3h, 0h10 ainda é o "dia" anterior
  assert.equal(L.isCacheFresh(found("2026-10-10T02:48:00Z"), t("2026-10-10T03:10:00Z"), { rolloverHour: 3 }), true);
  assert.equal(L.isCacheFresh(found("2026-10-10T02:48:00Z"), t("2026-10-10T06:10:00Z"), { rolloverHour: 3 }), false);
  // "não encontrada" vence em 6h mesmo no mesmo dia
  const missing = { prices: null, ts: t("2026-10-09T11:00:00Z") };
  assert.equal(L.isCacheFresh(missing, t("2026-10-09T16:00:00Z")), true);
  assert.equal(L.isCacheFresh(missing, t("2026-10-09T18:00:00Z")), false);
  assert.equal(L.isCacheFresh(undefined, Date.now()), false);
});

const moxDeck = {
  name: "Teste",
  boards: {
    mainboard: { cards: {
      a: { quantity: 1, card: { name: "Swords to Plowshares", type_line: "Instant", layout: "normal" } },
      b: { quantity: 9, card: { name: "Plains", type_line: "Basic Land — Plains", layout: "normal" } },
    } },
    commanders: { cards: { c: { quantity: 1, card: { name: "Giver of Runes", type_line: "Creature", layout: "normal" } } } },
    sideboard: { cards: { d: { quantity: 2, card: { name: "Rest in Peace", type_line: "Enchantment", layout: "normal" } } } },
  },
};

test("flattenDeck separa boards e detecta básicos", () => {
  const d = L.flattenDeck(moxDeck);
  assert.equal(d.cards.length, 4);
  assert.equal(d.hasCommanders && d.hasSideboard && d.hasBasics, true);
  assert.equal(d.cards.find((c) => c.name === "Plains").isBasic, true);
});

test("computeTotal respeita as opções (padrão DC500: só main, sem básicos)", () => {
  const d = L.flattenDeck(moxDeck);
  const prices = Object.fromEntries(d.cards.map((c) => [c.name, { prices: { min: 10 } }]));
  const base = { criterion: "min", includeBasics: false, includeCommanders: false, includeSideboard: false };
  assert.equal(L.computeTotal(d.cards, prices, base).total, 10);
  assert.equal(L.computeTotal(d.cards, prices, { ...base, includeSideboard: true }).total, 30);
  assert.equal(L.computeTotal(d.cards, prices, { ...base, includeCommanders: true, includeBasics: true }).total, 110);
});

test("isPriced: sideboard e comandante têm preço buscado mesmo fora do total", () => {
  const d = L.flattenDeck(moxDeck);
  const s = { includeBasics: false, includeCommanders: false, includeSideboard: false };
  const by = (n) => d.cards.find((c) => c.name === n);
  assert.equal(L.isPriced(by("Rest in Peace"), s), true);
  assert.equal(L.isPriced(by("Giver of Runes"), s), true);
  assert.equal(L.isPriced(by("Plains"), s), false);
});
