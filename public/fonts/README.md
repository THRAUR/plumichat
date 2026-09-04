# Fonts — self-hosted, on purpose

The four Plume typefaces, subset to `latin` + `latin-ext` (196 KB in total).
`@font-face` declarations live at the top of `../plume.css`.

They are served from here rather than linked from Google Fonts because PlumiChat is
installed to a phone's home screen and reached over Tailscale: the product must be
able to render itself without a third-party CDN resolving, and nothing about which
face is loading should leave the tailnet.

CJK is deliberately **not** subsetted in. `--font-body` falls through to
`system-ui`, so Traditional Chinese renders in PingFang on iOS instead of arriving
as a second megabyte of webfont.

| Face | Role | Licence |
|---|---|---|
| Pixelify Sans | display — wordmark, window titles, headings | SIL OFL 1.1 |
| Silkscreen | micro-labels — group headings, badges | SIL OFL 1.1 |
| Karla | body — every word you actually read | SIL OFL 1.1 |
| JetBrains Mono | code, paths, numerals | SIL OFL 1.1 |

All four are SIL Open Font License 1.1, which permits redistribution as part of a
larger work. Regenerate by fetching the Google Fonts CSS2 API with a modern
browser UA and downloading the `latin` / `latin-ext` `src` URLs it returns.
