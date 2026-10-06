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
5. Abra um deck público no Moxfield. O painel aparece no canto inferior direito.

## O que o painel faz

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
- Os preços ficam guardados por até 24 horas. Use **Limpar cache** para buscar tudo de novo.

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
