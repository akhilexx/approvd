# Bundled fonts

Served locally from `/fonts/` by the app itself (no external CDN, no tracking). Both are licensed under the
SIL Open Font License 1.1; the full licence texts are next to the files. Neither licence declares a Reserved
Font Name.

| File | Font | Copyright | Licence |
|---|---|---|---|
| `fraunces-latin-var.woff2` | Fraunces (variable, wght 400-700) | Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces) | [OFL-Fraunces.txt](OFL-Fraunces.txt) |
| `manrope-latin-var.woff2` | Manrope (variable, wght 400-800) | Copyright 2018 The Manrope Project Authors (https://github.com/googlefonts/manrope) | [OFL-Manrope.txt](OFL-Manrope.txt) |

How they were made (once, 2026-10-29): downloaded `ofl/fraunces/Fraunces[SOFT,WONK,opsz,wght].ttf` and
`ofl/manrope/Manrope[wght].ttf` with their `OFL.txt` from the official Google Fonts repository
(https://github.com/google/fonts, main at `9862abc`), then with fontTools:

```sh
fonttools varLib.instancer "Fraunces[SOFT,WONK,opsz,wght].ttf" SOFT=0 WONK=0 opsz=48 wght=400:700 -o fraunces.ttf
fonttools varLib.instancer "Manrope[wght].ttf" wght=400:800 -o manrope.ttf
pyftsubset <font>.ttf --flavor=woff2 --layout-features='kern,liga,calt,lnum,tnum' \
  --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
```

Source TTF sha256: Fraunces `177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb`,
Manrope `3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6`.
