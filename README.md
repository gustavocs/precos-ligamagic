# Preços LigaMagic no Moxfield

Extensão do Chrome que mostra, em qualquer deck do Moxfield, um painel com o valor do
deck pelos preços da LigaMagic. Funciona para qualquer formato, com limite de orçamento
opcional (por exemplo, R$ 500 para o Duel Commander 500).

## Aviso

Este é um projeto aberto e sem fins lucrativos, feito para ajudar a comunidade brasileira
de Magic, especialmente quem joga formatos com limite de orçamento, como o Duel Commander 500.

A extensão não tem afiliação com a LigaMagic nem com o Moxfield e não tem a intenção de
explorar ou prejudicar nenhum dos dois sites. Ela apenas exibe informações que já são
públicas, acessadas a partir do navegador de quem a usa, como faria uma pessoa navegando
pelas páginas, com cache e intervalo entre consultas para não sobrecarregar os serviços.

Se você representa a LigaMagic ou o Moxfield e tem alguma objeção ou sugestão, abra uma
issue neste repositório para conversarmos.

## Instalação

1. Baixe o repositório (Code → Download ZIP) e descompacte.
2. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta que contém o `manifest.json`.
4. Abra a LigaMagic uma vez numa aba normal.
5. Abra um deck público no Moxfield. O painel aparece no canto inferior direito; clique em
   **Buscar preços** para consultar a LigaMagic.

## O que o painel faz

- Só busca preços quando você clica em **Buscar preços**, para não consultar a LigaMagic
  em decks que você só está olhando. Marque **Buscar ao abrir decks** para buscar sozinho.
- Ao voltar a um deck já buscado, o painel mostra os preços guardados na hora, sem
  consultar nada, e diz há quanto tempo foram buscados.
- Arraste pelo título para mover; ele encaixa no canto mais próximo. Recolhido, a pílula
  também pode ser arrastada. Use a alça no canto livre para redimensionar. Duplo clique no
  título volta ao canto e ao tamanho padrão.
- Mostra o total do deck e, com limite definido, quanto sobra ou quanto passou.
- Critério de preço: menor, médio ou maior.
- Opções que aparecem só quando o deck tem aquilo: contar comandante, contar sideboard,
  contar básicos. O padrão segue o DC500: comandante, sideboard e básicos fora do total.
- Sideboard e comandante têm o preço exibido mesmo fora do total. Com limite definido, cada
  carta do sideboard ganha uma etiqueta de troca: "cabe" ou "sai ≥ R$ X" (quanto a carta
  do deck que sai precisa custar, no mínimo).
- Ordenação por maior preço (padrão), menor preço ou nome.
- ✎ em cada carta para informar um preço manual, que tem prioridade sobre a LigaMagic.
- Cartas marcadas com "conferir" merecem uma olhada na página da LigaMagic: passe o mouse
  sobre a etiqueta para ver o motivo.
- A LigaMagic atualiza os preços uma vez por dia, então o preço guardado vale até a virada
  do dia (horário de Brasília). Depois disso, **Recalcular** busca de novo só as cartas
  vencidas (até lá o painel mostra o último valor conhecido). Use **Limpar cache** para
  buscar tudo de novo.

## Privacidade

A extensão não envia dados para nenhum servidor próprio. Ela só acessa o Moxfield e a
LigaMagic a partir do seu navegador e guarda preferências, preços manuais e cache no
armazenamento local da extensão.

## Limitações conhecidas

- Decks privados do Moxfield não são suportados.
- O painel não se atualiza sozinho ao editar o deck: clique em **Recalcular**.
- Mudanças no layout da LigaMagic ou do Moxfield podem quebrar a extensão até uma
  atualização.

## Desenvolvimento

```bash
npm install
npm test
```

## Licença

[MIT](LICENSE)
