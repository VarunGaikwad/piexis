# PieXis icon

A coding `X` built from opposing terminal chevrons: orange (`#FF914D`) and ivory (`#FFF1DE`) on midnight (`#111827`). Rounded tile corners are transparent. All artwork is vector geometry, without font dependencies.

## Assets

- `apps/web/public/piexis-icon.svg` — scalable full-color icon.
- `apps/web/public/piexis-mark.svg` — transparent monochrome mark. Inline the SVG to inherit CSS `color`; an external `<img>` does not inherit the page's color.
- `apps/web/public/piexis-icon-{16,32,192,512}.png` — raster sizes for favicons, avatars, and launchers.
- `apps/web/public/piexis-icon.ico` — 16/32 px favicon.
- `assets/piexis-cli.txt` — portable ASCII fallback: `>< PieXis`.

## Web UI usage

Vite serves the public assets at the root:

```html
<link rel="icon" type="image/svg+xml" href="/piexis-icon.svg" />
<link rel="alternate icon" href="/piexis-icon.ico" />
<img src="/piexis-icon.svg" width="32" height="32" alt="PieXis" />
```

For an icon next to an existing PieXis label, use `alt=""` to avoid announcing the name twice. Adjust URLs if hosting under a subpath.

## CLI usage

Ordinary terminals need text rather than SVG or PNG. Use `><` as the compact mark or `>< PieXis` as the header. Optional orange ANSI coloring, with a plain fallback when color is disabled:

```sh
printf '\033[38;2;255;145;77m><\033[0m PieXis\n'
```

These files do not change the current web UI or CLI. No runtime dependencies were added.
