# EMGP26 certificates

Live at `https://emgp26-certificates.enhypenvoting.com` (same container, see "Own subdomain").

A public page where a crew member types their **E1 username**, picks it from the crew list (team, crew licence level and role come from the list) and gets their ENHYPEN MAMA Grand Prix crew licence as a 3D card, in the style of the e1.ensite.org licence.

- Page: `/crew-license` (`static/license.html`, `static/license.css`, `static/license.js`).
- The card is drawn in the browser; the only server part is the crew list search (`crew.py`).
- Levels: the 10 steps of the progression ladder and the 8 prestige distinctions (list in `LEVELS`, `license.js` and `crew.py`).
- Teams: Jaybull Racing (Jay), McJakey (Jake), Hoonrari (Sunghoon), Alpinoo (Sunoo), Meowcedes (Jungwon), Rikston Drift (Ni-ki).
- The 3D object is the **certificate of participation**: a paddock-pass style card in the team colour. Front: "Certificate of participation", the crew licence in a clear sleeve, a statement with username, team and level, access zones, certificate number, date and barcode. Back: ENHYPEN MAMA Grand Prix and ENHYPEN's 2026 MAMA Awards (`AWARDS` in `license.js`).
- Crew licence: one of the 18 licence designs (`static/licences/01.png` … `18.png`, 1600 x 900, level name already printed, name and team left blank) with the holder's username and team drawn on top, in the colours of that design (`INK` in `license.js`).
- 3D: [three.js](https://threejs.org) r170 (MIT, `static/vendor/three.module.min.js`), served locally because the site's CSP only allows scripts from the site itself. The card has thickness, a front and a back, a holographic foil that follows the viewing angle (stronger for prestige levels), drag to turn, "Flip card", phone motion (iOS asks permission after a tap) and an idle sway. Without WebGL the page shows the flat front.
- Finishes (3D, front and back, and the videos): none, holographic, galaxy (navy and cobalt, the MAMA 2026 night sky), stardust, aurora, prism, gold foil, sparkle (dense twinkling glitter) and cosmos holo (trading-card bubbles) (`FINISHES` and the foil shader in `license.js`).
- Card colour: team colour by default, or "Classic silver" (`CLASSIC` in `license.js`) for who prefers a neutral card; the embed keeps the choice (`color=classic`). Donors start with the holographic finish.
- Downloads: **certificate** (pass front, 2050 x 3000 PNG), **crew licence** (3200 x 1800 PNG) and **video** (4-second spin of the pass, 1080 x 1350, recorded in the browser: MP4 on Safari and recent Chrome, WEBM elsewhere).
- Font: Titillium Web (SIL OFL, `static/fonts/`).
- To change a design, replace its PNG in `static/licences/` (same size, keep the name/team area empty) and, if the text colour changes, its entry in `INK`.

## Crew list

`crew.csv` in the data volume (next to the database, `/app/data/crew.csv`; or the path in `CREW_CSV`). It is not in git.

- Columns: `username,team,level,role,x,donor`. `team` is the scuderia (Jaybull Racing, McJakey, Hoonrari, Alpinoo, Meowcedes, Rikston Drift, Independent Crew); "Team JAKE" style names also work, so the raw E1 export (`E1 username`, `Team`, `Crew Licence level`) can be uploaded as it is (without roles).
- `role`: empty, or one of Team Manager, Team Captain, Co-Team Captain, Race Engineer, E1 System Steward, Manual Steward, Media Crew (descriptions in `ROLES`, `license.js`). Two roles go in the same cell, separated by `&` (or `;` in a comma-separated file) (e.g. `Co-Team Captain; Social Media Creator`): both are shown in chrome, the second a step smaller on its own line ("& SOCIAL MEDIA CREATOR"), then the description of the first. Role holders get the role in chrome lettering instead of the access zones (real metal letters with a travelling glint in 3D).
- `x` (optional): X handles separated by spaces, or a `Social link` column (the raw export) from which the x.com handles are taken. After picking their name, a crew member can show one of their handles (as @handle) on the certificate instead of the E1 username; the project account and typo-short handles next to a real one are ignored.
- `donor` (optional): `yes` (or x, 1, sì) for crew members who donated to the campaign. They get a holographic "Campaign supporter" sticker above the QR code, with an embossed laurel wreath and star (in 3D a raised holo sticker whose rainbow moves with the angle). They also get a **Download donor certificate** button: a separate 3200 x 1800 PNG on white paper with a filigree, their name, team, a thank-you message, the team logo and a small supporter seal (`drawDonorCard`, `DONOR_THANKS` in `license.js`; team logos in `static/teams/`).
- Staff who are not admins (e.g. Paddock Announcers): team `EMGP Staff` (or EMGP Radio / Staff / Radio), level empty, their role. Same certificate as the admins with a **radio pass** (dark violet frame, RADIO tab, "EMGP Radio", a rising step over radio-wave arcs instead of the parquet) and the graphite finish instead of carbon.
- Creators and donors who did not race: their team, level empty, and role `Social Media Creator` (creators) or `donor` = yes (donors). They get a **Creator licence** or **Supporter licence**: the base crew licence layout with their own title, "Social Media Creator" / "Campaign Supporter" instead of a level and team-colour stripes (`drawSpecialLicence`, `SPECIAL` in `license.js`), and a statement that says how they supported the race.
- Staff (the organisers): team `EMGP Admin` (or Admin), level empty, role Circuit Operations, Admin Media Crew or Race Control. Their certificate has its own carbon fibre finish (`ADMIN_LOOK`) and an **admin pass** in the sleeve instead of the crew licence (`drawStaffPass`, inspired by paddock credentials: a recessed matte black panel inside a raised frame and side tab with a bevelled corner, in red for Race Control and white for the other admins, an art-deco double line over a chevron parquet, engraved in 3D, a holographic serial sticker, the role in large polished chrome (raised in 3D) and the name in large type), and no crew licence download.
- Commas, semicolons (Italian Excel, Numbers) or tabs all work; the upload answer lists the columns it found. The same username and team twice is merged (higher level kept). Usernames used more than once show the scuderia in the search, plus the level when the team is the same too.
- Upload or replace (admin login; the whole file is checked first, the old list stays if it is invalid):

  ```sh
  curl -u admin:PASSWORD -H 'Content-Type: text/csv' --data-binary @emgp26-crew.csv https://emgp26-certificates.enhypenvoting.com/api/crew
  ```

- `GET /api/crew?q=…` (up to 8 matches on the E1 username or an X handle: exact, then starts with, then contains; a leading @ is ignored; a match on a handle comes back as `via`), `GET /api/crew?id=…` (one entry; the embed code uses it, so name, team, level and role cannot be changed in the link).
- Without a list the page falls back to choosing team and level by hand.

## Own subdomain

The page is served by the same container, so the GitHub deploy is unchanged. Add a DNS record for the subdomain and a Caddy site that rewrites `/` to `/crew-license` (see `deploy/Caddyfile.example`), then reload Caddy.
