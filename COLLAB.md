# Collab verifier (`/collab-verify`)

Counts valid ENHYPEN voting proofs (Mnet Plus MAMA certificates) sent by partner fandoms. It lives in the admin area: the same Basic-auth login as `/admin`.

## What counts as a valid proof

1. **The last image of the certificate is ENHYPEN.** It is compared with the reference certificates uploaded in section 1 of the page.
2. **The collab's own image is where it should be.** Each partner fandom is defined as a *collab* (section 2) with the position of its image: first, second, or either. For example Lingshot batches must show Lingshot as the first image and ENHYPEN as the third; Taeyeon batches show Taeyeon plus ENHYPEN last. A collab without a partner image is checked for ENHYPEN only. A certificate with the wrong partner image is counted as *wrong partner image*, with the reason shown in the report.
3. **The certificate ID is read several times.** The whole "No. <ID>" line is read at different sizes, plain and binarised (3 readings, up to 8 when they disagree: the font is tightly spaced and a single reading can add or merge a character). The ID is accepted only when the readings agree: at least two votes, more than half of the valid readings and a margin of two over the runner-up. Otherwise the proof goes to manual review with the most likely ID already filled in.
4. **The ID is unique.** The database enforces this with a partial unique index, so two reviewers or two parallel uploads can never both count the same certificate. A byte-identical file is also recognised without OCR.
5. **No near-duplicates.** An ID that differs by exactly one character from an already counted ID (an OCR misread, or an edited code) goes to manual review instead of being counted.

Everything else is classified as **duplicate**, **not ENHYPEN** (including "ENHYPEN is not the last image"), **wrong partner image** or **manual review** (unreadable image or ID, cropped screenshot, ambiguous last or partner image, disagreeing OCR readings, near-duplicate ID).

## Certificates and phone screenshots

Both are accepted in the same batch. A phone screenshot (status bar, ad banner, *Save Image* button around the card) is recognised automatically: the server finds the certificate card (the large tinted area with the certificate proportions), cuts it out, and from there it follows exactly the same checks as an exported certificate. Because phones draw the card a few pixels off the exported layout, thumbnails of screenshots are compared over a small window of offsets. The same ID counts once whether it arrives as a screenshot or as a certificate. Screenshots also work as ENHYPEN or partner references.

A screenshot where the whole card is not visible (cropped, scrolled, covered by a dialog), or where the card cannot be found, goes to the Review tab as "Non-standard layout". The Review tab shows the cut-out card, not the whole screenshot.

## Using it

1. Upload one or more correct certificates as ENHYPEN references. Add one per version if the photo changes between rounds.
2. Add each collab: its name and the position of its image (first, second, first or second, or none). Then, on the collab card, add a sample certificate as the partner reference and say where the partner image sits in that sample. All references of a collab are accepted.
3. Upload proofs (tab **Upload**): choose the collab, set **Proofs date** (the day the votes refer to; today by default, never in the future), then a folder (recommended for thousands of files) or individual screenshots. One upload belongs to one collab: repeat for each batch. A collab that already has proofs cannot be removed.
4. Open the **Recap** tab: counters (valid, files, duplicates, not ENHYPEN, wrong partner image, to review, rejected) and the table fandom collab, valid proofs, date. Pick a date to filter. **Share cards** has one *Download card* button per collab: a PNG with only that fandom's valid proofs and date(s), to send to each partner fandom. It contains no IDs, certificate images or other collabs' numbers, and follows the selected date like the CSV. *Download summary CSV* has the three columns of the report; *Full report CSV* has one row per file with its ID and result. Downloads follow the selected date: `mama-valid-proofs-2026-11-05.csv`, or `mama-valid-proofs-all-as-of-<today>.csv` for all dates (the report is named `mama-proofs-report-...`).
5. Work through the **Review** tab (its badge counts everything waiting). It has three lists: **To verify** (the system could not decide: correct the ID if needed, then accept or reject; a one-character-different ID needs a second click), **Other groups** (rejected because the last image is not ENHYPEN) and **Wrong partner image** (the collab's own image is missing or misplaced). In the last two, a false rejection can be fixed: *Read ID from image* (or type it), then *Valid ENHYPEN proof*; *Confirm: not valid* clears the proof from the list and keeps its status in the recap.

Dates use `COLLAB_TIMEZONE` (default `Europe/Rome`) for the default and the future check. Uploading again for the same collab and the same proofs date adds to the same row.

## Cleaning test proofs

The first start after this update upgrades the `collab_*` tables once (marker in `collab_meta`): **all uploaded proofs, their submission rows and the duplicate index are deleted; collabs and reference images are kept.** The log shows how many proofs were removed. Later restarts never delete anything. To clean again at any time (for example after more tests), stop uploads and run inside the container: `python collab.py reset-proofs --yes`.

## Reading the review queue again

After an improvement of the checker, proofs waiting in the review lists can be checked again from their stored image, without uploading the files again. Each of the three lists (**To verify**, **Other groups**, **Wrong partner image**) shows a notice with how many proofs the new checker may judge differently, and a **Check them again** button that runs in the background with a progress bar (you can leave the page and come back). For **To verify** those are the proofs waiting only because the OCR could not confirm the ID an image was unclear or the layout was not recognised; for the other two lists, the proofs rejected as another group or for the partner image that nobody has confirmed yet. A proof is checked like a fresh upload: when it now passes it is counted, or marked as a duplicate, or kept in review if its ID is one character (or only look-alike characters) from a counted ID. A proof rejected as another group or wrong partner image whose images now match but whose ID needs a person moves to **To verify**. Proofs that still fail are left untouched, so it is safe to run it more than once. It shares the OCR budget with uploads.

**When the OCR is not sure of the ID.** The ID line is read up to eight times. "No." glued in front and characters the OCR inserts (a stray "S", "O"...) are removed by voting: every reading votes for each 16-character ID it can stand for, so the true ID collects the most votes even when no single reading is right. The image has already passed every check (ENHYPEN, partner image, layout), so the ID only has to be told apart from the others. When the readings are not unanimous, the proof is **counted** with the ID that has the most votes (or the only one), or with the first one if the candidates differ only in look-alike characters (O/0/Q/D/9, 1/I/L, 5/S/9, 8/B/S, 2/Z, 6/G, A/4, U/V); this applies only when no counted ID is the same, one character away, or the same apart from look-alike characters. The reason is then "ID not fully confirmed by the OCR; no similar ID is counted". If a similar ID is already counted, the proof stays in review, never counted twice. A tie between really different IDs, or no readable ID at all, also stays in review. The residual risk is a certificate whose ID is read wrongly in two or more places, which cannot be matched with its twin.

The same thing is available from the command line, inside the container: `python collab.py reprocess-review` (only counts them) and `python collab.py reprocess-review --yes` (every list at once).

## Resuming and retries

Each file has a key (fandom, path, size, modification time). The page asks the server which keys are already known and skips them, and the server returns the stored result for a key it has seen. After a crash, a Stop or a lost connection, select the same folder again: nothing is counted twice and only the missing files are processed. Network errors and 5xx responses are retried automatically.

## Server, data and limits

- Everything is stored in the existing SQLite database (`collab_*` tables, same volume), so it is part of your normal backups. Proof images are kept as 640 px JPEG previews for proofs that need review or were rejected; for valid proofs only the ID and file hash are kept.
- OCR uses the `tesseract` binary, installed by both Dockerfiles. **The image must be rebuilt** (a normal deploy does this) and the CI job installs it too.
- OCR confusions between the digit `0` and the letter `O` (and rarely `1`/`I`, `5`/`S`) can still happen on small or compressed images. They do not affect the count: the same certificate misread the same way is still a duplicate, a different misreading one character apart goes to manual review, and the Review tab shows the image so you can correct the text.
- `COLLAB_WORKERS` (default 2) sets how many images are analysed at once; about 3–4 files per second with 2 workers (clean certificates need 3 OCR readings, harder ones up to 8), so 20,000 certificates take roughly an hour and a half. Raise it on a bigger server, and keep an eye on `mem_limit` in `deploy/compose.production.yaml` (512m).
- `COLLAB_MAX_UPLOAD_MB` (default 12) limits a single image.
- The layout (positions of the three thumbnails and of the ID) is calibrated on the 930×1410 certificate export. A different layout is not rejected: it goes to manual review.
- This verifies that a certificate is consistent and unique. It cannot prove that the vote exists on Mnet Plus.

**Thumbnails that are drawn differently.** Some devices and app versions draw the three thumbnails a little wider, narrower or lower than the standard export. When the image does not match at the standard position, its position and size are searched for (a coarse search refined in a few steps, about 0.1 s) before it is judged. The same photo then scores above 0.98 instead of 0.4-0.8, while a different image stays far below the threshold. Images whose proportions differ from the export by up to 8% are accepted as certificates (5% before).

**One certificate, two spellings.** The OCR cannot tell O from 0 or 8 from S in this font, so the same certificate can be read in two ways. Every counted ID also has a look-alike key (O/0/Q/D/9/5/S/8/B are folded together, and the other look-alike pairs). A new ID with the same look-alike key as a counted one goes to review instead of being counted twice, even when it differs in several characters.

## Report link for every batch

Teams send their folder to the organiser, who uploads it. In the **Recap** table each batch (collab + proofs date) has a **Make link** button: it copies a private page address (`/report/<secret>`) to send to whoever asked for the verification.

- The page shows that batch's numbers (valid, duplicates, to verify, other group, wrong partner image, rejected) and lists the proofs to look at: **To verify**, **Other groups**, **Wrong partner image** and the confirmed **Rejected**. The requester can read the ID again, correct it, and accept or reject each proof, exactly like the organiser's Review tab. "Download CSV" gives the batch's results.
- The link is the only credential: it opens that one batch and nothing else (no other collab, no admin page). Messages never say which other collab or day an ID was counted for, and other IDs are not shown; the requester only learns that an ID is a duplicate or one character from one already counted.
- Reviews done from a link are saved as `link:<collab> <date>` in the full report CSV. "Copy link" gives the same link again; **Stop sharing** switches it off at once.
- The page is not indexed by search engines and sends no referrer. Treat the link like a password: anyone who has it can review that batch.

The Recap table has one row per verification run (collab + proofs date). Each row has **Card** (the share image: collab name, valid proofs and the run date), **Stats CSV** (the run's counts), **Report CSV** (the result of every file of the run) and the report link. Uploading more files for the same collab and date adds them to the same run.

## Importing from Google Drive

In **Upload**, under the folder pickers, paste a Google Drive link and press **Import from Drive**. The server lists the images of the folder (sub-folders included) or reads the single image, downloads them itself and checks them like any upload, using the collab and the proofs date chosen above. Nothing is downloaded on your device, and you can close the page: the progress is there when you come back.

- Needs `GOOGLE_API_KEY` in `.env` (a Google Cloud key with the Drive API enabled, restricted to it); restart the container after adding it. Without it the form says it is not set up.
- The folder or file must be shared as "Anyone with the link". Private ones answer "not found or not shared".
- Files are remembered by their Drive ID: after a stop or a failure, import the same link again and the finished files are skipped. Files that failed are tried again.
- One import runs at a time; three files are handled together and the OCR limit (`COLLAB_WORKERS`) still applies. Images over the upload limit (`COLLAB_MAX_UPLOAD_MB`) are reported as failed. Google may slow down downloads of the same file; the server waits and tries again a few times.
- A restart of the server stops a running import: import the same link again to continue.
