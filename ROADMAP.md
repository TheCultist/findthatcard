# Roadmap

What I plan to work on next, roughly in this order. It will change as I go.

## Query chips you can change

Clicking a chip in the generated query opens a small menu with the variants that make sense for that term; picking one edits the query text (the Colors and Printings rows too), and Search or Enter runs it; the button stays disabled while the text matches the last run, a cue marks stale results, a “Refined from” note keeps the natural-language origin visible, and a top-box search over chip edits offers a one-click restore (`lib/search-provenance.ts`). `/explain` lists the same options under each part. Done in `lib/query-variants.ts` for the numeric fields (`mv`, `pow`, `tou`, `loy`, `def`, `year`, `usd`, `eur`, `tix`), `c:` and `id:` (comparators and the swap between them), `r:`, format legality (`f:`, `banned:`, `restricted:`), `is:`/`not:`, `game:`, `order:`/`direction:`/`unique:`, swapping a written `or`/`and`, and excluding or removing any term or group (removal prunes the orphaned connectives and parentheses through the shared parser). Chips for `t:`, `kw:` and `set:` offer a searchable multi-select over the app's cached catalogs (no Scryfall calls); several picks become a parenthesized OR group. Still to do: `o:` value suggestions, turning an implicit AND (a plain space) into an `or`, and unwrapping a group left with a single term after a removal (`((b:y) d:w)`), which lives in the parser's `pruneQuery`.

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
