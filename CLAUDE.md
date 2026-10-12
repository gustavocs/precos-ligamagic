# CLAUDE.md

Extensão do Chrome (Manifest V3) que mostra, num painel flutuante dentro de decks do
Moxfield, o valor do deck pelos preços da LigaMagic. Público principal: jogadores
brasileiros de formatos com limite de orçamento (Duel Commander 500).

## Estrutura

- `manifest.json`: MV3. Content scripts `lib.js` + `content.js` (nessa ordem) em
  `moxfield.com`; service worker `background.js`. Host permissions só para
  `www.ligamagic.com.br` e `api2.moxfield.com`.
- `lib.js`: **lógica pura**, sem `chrome.*` nem DOM global. Expõe `LigaPrecos` (global no
  navegador, `module.exports` no Node). Parsing da LigaMagic, leitura do deck do
  Moxfield, regras de contagem e soma. Tudo que puder ser testado fora do navegador mora aqui.
- `content.js`: estado, cache, fila de busca, painel (Shadow DOM) e eventos. Uma IIFE só.
- `background.js`: `fetchText` (fetch com cookies, sem CORS) e `renderAndExtract`
  (abre a carta numa aba em segundo plano reaproveitada e devolve o HTML renderizado).
- `tests/lib.test.js`: testes de `lib.js` com `node:test` + `jsdom`.

Sem build, sem bundler, sem dependências em runtime. JavaScript puro que o Chrome carrega direto.

## Fluxo

1. `checkLocation()` roda a cada 1 s (Moxfield é SPA) e detecta `/decks/{id}`. O painel
   abre em `phase: "idle"` e só busca ao clicar em **Buscar preços** (ou sozinho, se
   `settings.autoSync`). Não fazer nenhuma requisição antes disso. Se o deck já foi
   buscado antes, `restore()` remonta o painel com o snapshot do deck + cache de preços
   (mesmo vencido, via `cacheRead`), sem rede, e marca `state.restored`.
2. Deck vem de `https://api2.moxfield.com/v3/decks/all/{id}` via `fetchText` → `flattenDeck`.
   Boards considerados: mainboard, companions, commanders, sideboard (maybeboard fica de fora).
3. `priceMissing()` monta a fila (o que conta no total primeiro) e busca carta a carta,
   com `REQUEST_GAP_MS` (900 ms) entre requisições.
4. Para cada nome em `card.lookups` (dupla-face/split têm fallback): cache → LigaMagic.
5. `render()` chama `renderPanel()` (conteúdo) e `applyLayout()` (posição/tamanho) a cada
   preço que chega. Ver "Convenções" para como o painel é atualizado.

## Como o preço é extraído da LigaMagic

A página da carta (`?view=cards/card&card=<nome>`) traz um `<script>` com um array JSON de
edições, cada uma com `price` por variante: `p` = menor, `m` = médio, `g` = maior.
O preço da oferta no marketplace é ofuscado (sprite), mas a **edição** da primeira oferta é
texto. Prioridade em `analyzeCardPage`:

1. `source: "listing"`: edição da primeira oferta casada no JSON (por `idkey` → `code` → `name`).
2. `source: "editions"` + `check: true`: menor valor entre todas as edições (sem oferta ou
   edição não encontrada).
3. `source: "page"` + `check: true`: blocos `.price-mkp` da página (só a edição exibida).

`check: true` vira a etiqueta "conferir" e `note` vira o tooltip.

**Página em grade** (cartas com muitas reimpressões, ex.: Duress, Shock): a Liga não mostra
marketplace nem `cards_editions`; a página é uma grade de edições alimentada por
`var cardsjson = [...]`, com `p1a`/`p1b`/`p1c` (menor/médio/maior) por edição e `nEN` como
nome. `analyzeCardPage(html, root, name)` detecta isso antes de tudo (`findCardsGrid`) e
devolve `{ grid: true, prices: { source: "grid", ... } }`: menor valor por critério entre as
entradas com `nEN` igual ao nome buscado (`pricesFromGrid`; variações como "Duress (#7b)" são
outras cartas na Liga; `0.00` = sem oferta). Sem o nome exato, usa todas e marca `check`.
Os dados vêm no HTML cru, então `fetchFromLiga` não abre a aba para essas cartas.

**Modo de busca** (`fetchMode`): começa com `fetch` cru. Se cair no Cloudflare ou se a lista
de ofertas só existir após o JavaScript, passa para `tab` (aba em segundo plano) até o fim da
sessão. A aba é fechada com `releaseWorkerTab` ao terminar a fila.

## Armazenamento (`chrome.storage.local`)

- `settings`: critério, limite, ordenação, recolhido, includeBasics/Commanders/Sideboard,
  `autoSync`, `inlinePrices`, `pos` (`{ h, v, x, y }`: canto ao qual o painel está preso + distância) e
  `size` (`{ w, h }`). `null` em `pos`/`size` = padrão (canto inferior direito, tamanho automático).
- `overrides`: preço manual por nome de carta (por unidade; tem prioridade sobre a Liga).
- `lm4:<nome em minúsculas>`: cache `{ prices, ts }`. Preço encontrado vale até a virada do
  dia em Brasília (a Liga atualiza uma vez por dia); "não encontrada" vale 6 h, dentro do
  mesmo dia. Regra em `L.isCacheFresh` (`lib.js`), parâmetros em `CACHE_RULES`
  (`content.js`): se a Liga atualizar mais tarde, mude `rolloverHour` (ex.: 3).
  **Ao mudar o formato de `prices`, incremente o prefixo** (`lm5:` …): entradas antigas
  passam a ser ignoradas e `clearCache` apaga qualquer `lm\d*:`. Não é preciso trocar o
  prefixo a cada versão: só quando o formato mudar.
- `deck:<publicId>`: `{ deck, ts }`, a lista de cartas (`flattenDeck`) salva em cada
  `run()`. Guarda os 50 mais recentes. `clearCache` não apaga. Snapshots anteriores à
  opção de preços na lista não têm `ids` nas cartas (ver abaixo).

## Preços na lista do Moxfield (`settings.inlinePrices`)

Mostra o preço ao lado de cada nome na lista do deck, fora do painel. Só na visualização
em texto: `select#viewMode` com `table` (Text) ou `condensedTable` (Condensed Text). Em
outra visualização, as etiquetas somem e o painel mostra `.inline-note` pedindo para trocar.

- Linha do Moxfield: `li[data-testid="deck-view-table-row"]`, com `data-hash` = `card.id`
  da API (id da impressão) e o nome em `a.table-deck-row-link[href^="/cards/"]`. A primeira
  coluna da linha é a quantidade. Classes com hash (ex.: `XIi4jFys...`) mudam a cada
  deploy do Moxfield: não usar.
- A carta do deck é achada por `L.findCard`: pelo `data-hash` (`card.ids`, guardado por
  `flattenDeck`) e, se não achar, pelo nome do link. O id é necessário para impressões com
  nome alternativo (Valakut aparece como "Volcano of Roku's Island").
- **Não criar elementos dentro da árvore do React.** O preço vai no atributo
  `data-lm-price` (e `data-lm-kind`: `counted`, `out`, `missing`) do elemento pai do link,
  e aparece por CSS `::after` (`INLINE_CSS`, injetado na página como
  `#precos-ligamagic-inline`; 13 px; cores por `data-lm-kind`, com variante para `html.darkmode`,
  o tema escuro do Moxfield; nada de `opacity`, que somaria com a cor). Quando o React recria a linha, o atributo some e o
  `MutationObserver` em `document.body` marca de novo (`scheduleInline`, 150 ms de folga,
  porque anúncios mexem no DOM o tempo todo).
- `syncInline()` roda a cada `render()`: liga/desliga o observer e reaplica. Regra da
  etiqueta em `L.inlineLabel` (mesmas regras do painel: `isPriced`/`isCounted`).

## Convenções

- Textos da interface, comentários e mensagens de commit em **português (pt-BR)**.
- Valores em BRL formatados com `Intl.NumberFormat("pt-BR", { currency: "BRL" })`.
- HTML do painel é montado com template strings: **sempre** passar texto vindo de fora
  (nomes de cartas, notas, erros) por `esc()`.
- CSS fica na constante `CSS` dentro do Shadow DOM (`:host { all: initial; }`), para não
  vazar estilos do Moxfield nem para ele.
- O painel tem quatro telas (`pill`, `idle`, `loading`, `full`). `SKELETONS[tela]` monta a
  estrutura só quando a tela ou o deck muda; `UPDATES[tela]` atualiza a cada render apenas
  o que muda (total, barra, status, progresso, lista). Controles não são recriados no meio
  do uso, então foco e texto digitado se mantêm. Só a `.list` é redesenhada por inteiro.
  Elemento novo que muda com os preços: colocar no esqueleto e atualizar em `UPDATES`.
- Posição/tamanho ficam em estilos inline no `.panel` (o próprio elemento não é recriado).
  O painel fica preso ao canto mais próximo, cresce para longe da borda, e a alça de
  redimensionar fica no canto livre. Arraste usa listeners no `document`.
- Largura padrão e mínima do painel: 364 px, para Recalcular / Limpar cache / Ordenar
  caberem numa linha. Ao mudar textos dessa linha, conferir se continua cabendo.
- Opções do painel só aparecem quando o deck tem aquilo (comandante, sideboard, básicos).
  Padrão segue o DC500: comandante, sideboard e básicos fora do total.
- Lógica nova e testável vai para `lib.js` com teste em `tests/lib.test.js`.
- Manter o `README.md` em dia quando uma funcionalidade visível mudar.

## Limites que não devem ser quebrados

- Respeito aos sites: manter cache e intervalo entre requisições; não paralelizar buscas
  na LigaMagic nem reduzir o intervalo sem motivo forte. O README promete isso.
- Privacidade: nada de servidor próprio, telemetria ou envio de dados a terceiros.
- Não pedir permissões novas no manifest sem necessidade clara.

## Testes

```bash
npm install
npm test        # node --test tests/*.test.js
```

Os fixtures de HTML nos testes reproduzem a estrutura observada na LigaMagic (out/2026).
Se a Liga mudar o layout, atualize o fixture junto com o parser.

Teste manual: `chrome://extensions` → Modo do desenvolvedor → Carregar sem compactação →
abrir um deck público no Moxfield. Depois de editar, clicar em recarregar na extensão e dar
F5 na aba do Moxfield (content scripts não recarregam sozinhos).

## Ambiente

Desenvolvimento em Windows (`core.ignorecase = true`). Repositório:
`github.com/gustavocs/precos-ligamagic`, branch `main`.
