# Collab verifier (`/collab-verify`)

Counts valid ENHYPEN voting proofs (Mnet Plus MAMA certificates) sent by partner fandoms. It lives in the admin area: the same Basic-auth login as `/admin`.

## What counts as a valid proof

1. **The last image of the certificate is ENHYPEN.** It is compared with the reference certificates uploaded in section 1 of the page.
2. **The collab's own image is where it should be.** Each partner fandom is defined as a *collab* (section 2) with the position of its image: first, second, or either. For example Lingshot batches must show Lingshot as the first image and ENHYPEN as the third; Taeyeon batches show Taeyeon plus ENHYPEN last. A collab without a partner image is checked for ENHYPEN only. A certificate with the wrong partner image is counted as *wrong partner image*, with the reason shown in the report.
3. **The certificate ID is read twice, independently.** Two OCR readings (different scale and preprocessing) must agree; a third, binarised reading breaks ties. Otherwise the proof goes to manual review.
4. **The ID is unique.** The database enforces this with a partial unique index, so two reviewers or two parallel uploads can never both count the same certificate. A byte-identical file is also recognised without OCR.
5. **No near-duplicates.** An ID that differs by exactly one character from an already counted ID (an OCR misread, or an edited code) goes to manual review instead of being counted.

Everything else is classified as **duplicate**, **not ENHYPEN** (including "ENHYPEN is not the last image"), **wrong partner image** or **manual review** (unreadable image or ID, cropped screenshot, ambiguous last or partner image, disagreeing OCR readings, near-duplicate ID).

## Using it

1. Upload one or more correct certificates as ENHYPEN references. Add one per version if the photo changes between rounds.
2. Add each collab: its name and the position of its image (first, second, first or second, or none). Then, on the collab card, add a sample certificate as the partner reference and say where the partner image sits in that sample. All references of a collab are accepted.
3. Upload proofs: choose the collab, then a folder (recommended for thousands of files) or individual screenshots. One upload belongs to one collab: repeat for each batch. A collab that already has proofs cannot be removed.
4. Read the **Valid proofs** table: fandom collab, valid proofs, date, plus files, duplicates, not ENHYPEN, wrong partner image, manual queue and rejected. *Export summary CSV* has the three columns of the report; *Full report CSV* has one row per file with its ID and result.
5. Work through the **manual review** queue: correct the ID if needed, then *Valid ENHYPEN proof* or *Reject*. A one-character-different ID needs a second click to confirm it is a different certificate.

Dates use `COLLAB_TIMEZONE` (default `Europe/Rome`). Uploading again for the same fandom on the same day adds to the same row.

## Resuming and retries

Each file has a key (fandom, path, size, modification time). The page asks the server which keys are already known and skips them, and the server returns the stored result for a key it has seen. After a crash, a Stop or a lost connection, select the same folder again: nothing is counted twice and only the missing files are processed. Network errors and 5xx responses are retried automatically.

## Server, data and limits

- Everything is stored in the existing SQLite database (`collab_*` tables, same volume), so it is part of your normal backups. Proof images are kept as 640 px JPEG previews for proofs that need review or were rejected; for valid proofs only the ID and file hash are kept.
- OCR uses the `tesseract` binary, installed by both Dockerfiles. **The image must be rebuilt** (a normal deploy does this) and the CI job installs it too.
- `COLLAB_WORKERS` (default 2) sets how many images are analysed at once; about 4–5 files per second with 2 workers, so 20,000 certificates take roughly an hour. Raise it on a bigger server, and keep an eye on `mem_limit` in `deploy/compose.production.yaml` (512m).
- `COLLAB_MAX_UPLOAD_MB` (default 12) limits a single image.
- The layout (positions of the three thumbnails and of the ID) is calibrated on the 930×1410 certificate export. A different layout is not rejected: it goes to manual review.
- This verifies that a certificate is consistent and unique. It cannot prove that the vote exists on Mnet Plus.
