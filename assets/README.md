# Brand assets

*Added 2026-09-02.* The two images the Worker serves are embedded in the code as base64 (`src/og-image.ts`, `src/favicon.ts`) so the deploy stays a single file with no asset bucket. The HTML files here are their source of truth; the PNGs are what got rendered from them.

| Source | Rendered | Served at | Used for |
|---|---|---|---|
| `og-card.html` | `og-card.png` (1200x630) | `/og.png` | Link previews (iMessage, Slack, Twitter cards) via the `og:image` tag on the start, connect, and privacy pages |
| `icon.html` | `icon-256.png` (256x256) | `/favicon.png`, `/favicon.ico`, `/apple-touch-icon.png` | Browser tab, iOS home screen, the OAuth `logo_uri`, and the MCP server icon |

## Re-rendering after an edit

Any headless browser works. With the Playwright CLI (the Playwright MCP's browser cannot open `file://` URLs, so serve the folder first):

```bash
cd assets && python3 -m http.server 8791 --bind 127.0.0.1 &
npx playwright screenshot --viewport-size=1200,630 --wait-for-timeout=2500 http://127.0.0.1:8791/og-card.html og-card.png
npx playwright screenshot --viewport-size=256,256 http://127.0.0.1:8791/icon.html icon-256.png
kill %1
```

The card loads Barlow from Google Fonts, so give it the wait. Then embed the bytes:

```bash
python3 - <<'EOF'
import base64, re
for png, ts, name in [("assets/og-card.png", "src/og-image.ts", "OG_PNG_B64"), ("assets/icon-256.png", "src/favicon.ts", "FAVICON_PNG_B64")]:
    b64 = base64.b64encode(open(png, "rb").read()).decode()
    src = open(ts).read()
    src = re.sub(rf'(export const {name} =\n  ")[^"]+(")', lambda m: m.group(1) + b64 + m.group(2), src)
    open(ts, "w").write(src)
EOF
```

Keep the card under about 100 KB; the whole Worker bundle ships on every request.

## What the connector card in Claude shows

Claude's connector list reads the icon from the OAuth discovery metadata (`logo_uri`, injected in `src/index.ts`). Where it instead shows the parent domain's favicon, that is the host's choice, not something this server can override; see the self-hosted-mcps `LESSONS.md` entry from 2026-09-01.
