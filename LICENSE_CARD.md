# EMGP26 certificates

Live at `https://emgp26-certificates.enhypenvoting.com` (same container, see "Own subdomain").

A public page where a crew member enters **username, team and crew licence level** and gets their ENHYPEN MAMA Grand Prix crew licence as a 3D card, in the style of the e1.ensite.org licence.

- Page: `/crew-license` (`static/license.html`, `static/license.css`, `static/license.js`).
- No backend, no database, nothing uploaded: the card is drawn in the browser.
- Levels: the 10 steps of the progression ladder and the 8 prestige distinctions (list in `LEVELS`, `license.js`). The level is self-declared, there is no verification.
- Teams: Jaybull Racing (Jay), McJakey (Jake), Hoonrari (Sunghoon), Alpinoo (Sunoo), Meowcedes (Jungwon), Rikston Drift (Ni-ki).
- The 3D object is the **certificate of participation**: a paddock-pass style card in the team colour. Front: "Certificate of participation", the crew licence in a clear sleeve, a statement with username, team and level, access zones, certificate number, date and barcode. Back: ENHYPEN MAMA Grand Prix and ENHYPEN's 2026 MAMA Awards (`AWARDS` in `license.js`).
- Crew licence: one of the 18 licence designs (`static/licences/01.png` … `18.png`, 1600 x 900, level name already printed, name and team left blank) with the holder's username and team drawn on top, in the colours of that design (`INK` in `license.js`).
- 3D: [three.js](https://threejs.org) r170 (MIT, `static/vendor/three.module.min.js`), served locally because the site's CSP only allows scripts from the site itself. The card has thickness, a front and a back, a holographic foil that follows the viewing angle (stronger for prestige levels), drag to turn, "Flip card", phone motion (iOS asks permission after a tap) and an idle sway. Without WebGL the page shows the flat front.
- Downloads: **certificate** (pass front, 2050 x 3000 PNG), **crew licence** (3200 x 1800 PNG) and **video** (4-second spin of the pass, 1080 x 1350, recorded in the browser: MP4 on Safari and recent Chrome, WEBM elsewhere).
- Font: Titillium Web (SIL OFL, `static/fonts/`).
- To change a design, replace its PNG in `static/licences/` (same size, keep the name/team area empty) and, if the text colour changes, its entry in `INK`.

## Own subdomain

The page is served by the same container, so the GitHub deploy is unchanged. Add a DNS record for the subdomain and a Caddy site that rewrites `/` to `/crew-license` (see `deploy/Caddyfile.example`), then reload Caddy.
