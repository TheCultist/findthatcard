# Roadmap

What I plan to work on next, roughly in this order. It will change as I go.

## Query chips you can change

Clicking a chip in the generated query opens a small menu with the variants that make sense for that term: switch `pow>=4` to `>`, `=` or `<=`, swap `c:` for `id:`, move `f:modern` to another format, negate the term or drop it. Picking one reruns the search. It should reuse the shared parser in `lib/scryfall/query-ast.ts`, so the chips, the query editor and `/explain` agree on what a term is.

## Show why a card matched

Highlight the part of the oracle text that matches each `o:` term, both in the results grid and in the card detail panel.

## Search from a decklist

Paste a decklist and the search picks up the commander's color identity and hides the cards that are already in the list.

## A /syntax reference page

One page listing the Scryfall keywords the app already explains, built from the copy in `lib/query-tokens.ts`, with examples you can run.

## Queries in other languages

A description written in Italian, Spanish or French should give the same filters as the English one. This needs new prompt rules and a round of checks with `npm run search:qa`.

## Keyboard and screen reader pass

Move through the results grid, the detail panel and the query chips with the keyboard only, and check the labels with a screen reader.
