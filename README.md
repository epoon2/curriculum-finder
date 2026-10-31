# Curriculum Finder

A private search page for a tutoring center's curriculum library. Instructors type a
topic, a skill or a document code ("adding fractions", "slope", "PK 186"), or upload a
photo of notes or an example problem, and get the matching worksheets with their
codes, levels and page counts. **Open PDF** opens the worksheet itself, on any device.

**This repo is only the code.** The curriculum (the library catalog and the PDFs) is
licensed to the center, so none of it is here: it lives in a private Cloudflare R2
bucket and is served only to signed-in staff. The tests run on a small made-up
library (`tests/sample_library.json`).

- **Where it runs:** Cloudflare Pages, Pages Functions and R2, all on free plans.
- **Who can open it:** only the staff emails on a Cloudflare Access list, each signing
  in with a one-time code emailed to them. Everyone else gets a sign-in screen and
  never sees the page, the library or a PDF.
- **Image search:** a vision model says what math the photo shows, and that becomes
  the search. By default it's Gemma 4 on Cloudflare Workers AI (free within a daily
  allowance; the photo stays inside Cloudflare); Claude can be used instead with an
  API key. Nothing is saved, neither the image nor the reading.

## How it works

```
staff browser ──► Cloudflare Access (email + one-time code)
                        │
                        ▼
                 Cloudflare Pages
                  ├─ public/          the page: HTML, JS, CSS (no curriculum in it)
                  └─ functions/api/
                       ├─ library      GET  library.json ─┐
                       ├─ pdfs         GET  which codes have a PDF
                       ├─ pdf/<code>   GET  one PDF ──────┼──► private R2 bucket
                       └─ read-image   POST a photo ──► Workers AI (or Anthropic API)
```

- **Search runs in the browser.** The page loads the library once (about 900 KB,
  cached with an etag), and every keystroke searches it locally: BM25 scoring per
  field (title, critical skills, keywords, topic tags, file name), weighted, then
  ranked by how many of the searched words a document covers. Word families are
  folded together ("dividing", "division" and "quotient" all count as divide), so
  staff don't need the library's exact wording.
- **Every server route checks the sign-in itself.** Access sits in front of the site,
  and on top of that each route verifies the Access token (its RS256 signature
  against the team's public keys, its audience and its expiry; `lib/access.js`)
  before it reads anything. If Access were switched off by mistake, or a hostname
  were left out of it, the routes would still refuse to answer.
- **The bucket has no public address.** No r2.dev URL and no custom domain: the only
  way to an object is through the routes above. The PDF route accepts only document
  codes (`PK-0186-00`), so nothing else in the bucket can be reached with it.
- **The center's own names live in the data, not the code.** The library file carries
  the center's name, what its curriculum system is called and, optionally, a link
  pattern for opening a document there. They're set when the library is built and
  stay as private as the library.

## What's in the repo

| Path | What it is |
| --- | --- |
| `public/index.html`, `app.js`, `style.css` | The page |
| `public/search.js` | The search (word families, BM25 ranking, code lookup) |
| `public/_headers` | Security headers: the page can only talk to its own site, can't be framed, isn't indexed |
| `functions/api/library.js` | `GET /api/library`: the library, from the bucket |
| `functions/api/pdfs.js` | `GET /api/pdfs`: which codes have a PDF, so only those cards get the link |
| `functions/api/pdf/[code].js` | `GET /api/pdf/<code>`: one PDF, with byte ranges for the browser's viewer |
| `functions/api/read-image.js` | `POST /api/read-image`: the image reader |
| `lib/access.js` | Verifies the Cloudflare Access sign-in token, for every route |
| `lib/library.js`, `lib/pdf.js`, `lib/reader.js` | What the routes do |
| `tools/build_library.py` | Turns the curriculum system's library export (.xlsx) into `library.json` |
| `tools/upload_curriculum.py` | Uploads `library.json` and the PDFs from the center's computer to the bucket |
| `tools/extract_text.py` | Pulls the text out of the PDFs, for searching inside them later |
| `tests/` | Unit tests, a browser test, and the made-up sample library |

There is no build step and nothing to install to run the site.

## Setup (one time)

You need free accounts at GitHub and Cloudflare (and the Claude Console only if you
choose Claude for image search). Below, `<project>` is your Pages project name and
`<bucket>` your R2 bucket name.

### 1. GitHub

Create a repository and upload this code. Public or private both work, since the
repo holds no curriculum. **Never add** the library export, `library.json`, the PDFs
or text pulled out of them; `.gitignore` keeps them out if you use git.

### 2. Cloudflare Pages: the site

1. In the Cloudflare dashboard: **Workers & Pages → Create application**, the
   **Pages** tab (or the "Looking to deploy Pages?" link) **→ Connect to Git**.
2. Connect GitHub and give Cloudflare access to **only** this repository.
3. Pick the repo, then **Begin setup**:
   - Project name: `<project>` (this becomes `<project>.pages.dev`)
   - Production branch: `main`
   - Framework preset: **None**
   - Build command: leave **empty**
   - Build output directory: `public`
4. **Save and Deploy.** The page loads for anyone at this moment, but it has no
   library to show until step 6, and step 3 locks it.

### 3. Cloudflare Access: staff-only sign-in

1. Open **Zero Trust**. The first time, it asks for a team name and a plan: choose
   **Free** (up to 50 users). It asks for payment details even on the Free plan; it
   doesn't charge them.
2. **Zero Trust → Settings → Authentication → Login methods:** make sure
   **One-time PIN** is listed. If not, **Add new → One-time PIN**.
3. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
   - Application name: `Curriculum Finder`
   - Session duration: `1 week` (how often staff re-enter a code; shorter is stricter)
   - Add **two** public hostnames:
     - subdomain *empty*, domain `<project>.pages.dev`
     - subdomain `*`, domain `<project>.pages.dev` (the preview address of each deployment)
   - Add any custom domain you use for the site as a third hostname.
4. Add a policy: name `Staff`, action **Allow**, include **Emails** and list each
   staff email (or **Emails ending in** `@yourcenter.com`).
5. Save. Open the site in a private window: you should get a Cloudflare sign-in
   screen, receive a code by email, and land on the page. An email not on the list
   gets no code.
6. Open the application again and copy its **Application Audience (AUD) Tag**, and
   note your team domain from **Zero Trust → Settings → Team name and domain** (it
   ends in `.cloudflareaccess.com`). Both go into step 5.

To add or remove staff later, edit the `Staff` policy. No upload is needed.

### 4. Image search: Workers AI (free)

**Workers & Pages → `<project>` → Settings → Bindings → Add → Workers AI**, variable
name `AI`, for **Production**. That's all: no account, key or card. The reader uses
Gemma 4 (`@cf/google/gemma-4-26b-a4b-it`); set `AI_MODEL` in step 5 to use another
Workers AI vision model.

*Or Claude instead* (paid per image, better on messy handwriting): sign in at
**platform.claude.com**, add a little credit under **Billing** (the API is billed
separately from a Claude subscription), create a workspace named `Curriculum Finder`
with a monthly **Spend limit**, and create an API key in it. Add it in step 5 as
`ANTHROPIC_API_KEY`. When the key is set, it's used instead of Workers AI.

### 5. Cloudflare Pages: the settings

In **Workers & Pages → `<project>` → Settings → Variables and Secrets**, add these
for **Production**:

| Name | Type | Value |
| --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | Text | your team domain, like `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | Text | the AUD tag from step 3 |
| `AI_MODEL` | Text | *optional*; another Workers AI vision model |
| `ANTHROPIC_API_KEY` | **Secret** | *only for Claude*: the key from step 4 |
| `MODEL` | Text | *optional, Claude only*; leave it out for `claude-haiku-5-5` |

Settings take effect on the next deployment: **Deployments →** the latest one **→
Retry deployment**.

### 6. Cloudflare R2: the library and the PDFs

**a. The bucket**

1. **Storage & databases → R2 object storage.** The first time, it asks you to
   subscribe to R2 and add a payment method; the free allowance covers a library
   like this (see Costs).
2. **Create bucket:** name `<bucket>`, location **Automatic**, default storage class
   **Standard** (not Infrequent Access, which charges for every read).
3. In the bucket's **Settings**, under **Public access**, leave the **Public
   Development URL** (r2.dev) **disabled** and add **no custom domain**. Those are
   the defaults.

**b. Connect it to the site**

1. **Workers & Pages → `<project>` → Settings → Bindings → Add → R2 bucket.**
2. Variable name `CURRICULUM`, bucket `<bucket>`, for **Production**. Leave Preview
   without it (and without the step 5 settings), so preview deployments never
   reach the curriculum.
3. **Deployments →** latest **→ Retry deployment.**

**c. An upload key (for the center's computer only)**

1. **R2 object storage → Overview → API Tokens: Manage → Create Account API token.**
2. Permission **Object Read & Write**, **Apply to specific buckets only →
   `<bucket>`**. A TTL of a week is plenty if the token is only for the first upload.
3. Create, and keep the page open: it shows the **Access Key ID** and **Secret Access
   Key** once, and the endpoint `https://<account id>.r2.cloudflarestorage.com`.
   Don't save the keys in a file, email or chat.

**d. Build the library and upload everything**

On the computer with the curriculum (Python 3 needed), put `build_library.py` and
`upload_curriculum.py` in one folder with the library export, open PowerShell there:

```
python build_library.py "Curriculum_Library_Export (MM_DD_YYYY).xlsx" --center "Your Center" --platform "Your curriculum system"
python -m pip install boto3
python upload_curriculum.py "D:\Curriculum PDFs" --dry-run
```

`build_library.py` writes `library.json` next to the export and prints counts. The
dry run uploads nothing and needs no key. It writes `upload_report.csv` next to the
PDF folder: each file, the code it was read as, and what will happen. Check the lines
marked **not in the library** (a name read wrong) and **library PK with no PDF found**.
When a code has more than one file, the highest `_v` number is kept.

Then, in the same PowerShell window (the keys last only until it's closed):

```
$env:R2_ACCOUNT_ID = "<account id>"
$env:R2_ACCESS_KEY_ID = "<access key id>"
$env:R2_SECRET_ACCESS_KEY = "<secret access key>"
$env:R2_BUCKET = "<bucket>"
python upload_curriculum.py "D:\Curriculum PDFs"
```

It uploads `library.json`, then the PDFs as `pdf/<code>.pdf`, printing progress every
100 files and a total. Run it again any time: anything already in the bucket is
skipped, so only new or changed files go up.

**e. Check it's private (signed out)**

In a private window, with no sign-in, each of these must show the Cloudflare Access
sign-in screen, never the library, a list or a PDF:

- `https://<project>.pages.dev/api/library`
- `https://<project>.pages.dev/api/pdfs`
- `https://<project>.pages.dev/api/pdf/<any code you uploaded>`
- the same three on a preview address (**Deployments →** an older one → its
  `https://<id>.<project>.pages.dev` link), and on any custom domain

Or in PowerShell: `curl.exe -sI https://<project>.pages.dev/api/library` should answer
a redirect (`302`, with a `location:` on `cloudflareaccess.com`), never `200`.

Then sign in normally. The header shows your center's name and the library's size;
cards with a PDF have **Open PDF**. If the page says the library isn't connected, the
binding or the redeploy in **b** is missing; if it says it hasn't been uploaded, run
**d**. A new upload shows up within 10 minutes.

## Updating the library

When documents are added or changed in the curriculum system:

1. Export the **Curriculum Library** again (.xlsx).
2. Rebuild and upload, from the same folder as before:
   ```
   python build_library.py "Curriculum_Library_Export (MM_DD_YYYY).xlsx" --center "Your Center" --platform "Your curriculum system"
   python upload_curriculum.py
   ```
   Without a folder, only `library.json` goes up (when it changed). Add the PDF folder
   to upload new PDFs at the same time.

Staff get the new library the next time they open the page. Nothing changes on GitHub
and nothing is redeployed.

`--doc-url "https://.../{id}"` (optional) adds an **Open in** link to each card, with
`{id}` replaced by the document's id in the export.

## How searching works

- Words are matched against the title (strongest), topic tags, critical skills,
  keywords and the file name, with word families folded together: "dividing" also
  finds "division" and "quotient"; "percent" finds "percentage".
- Documents that contain **all** the words, especially in the title, rank first.
  Weak partial matches (under a fifth of the best score) are dropped, so a precise
  search gives a short list and a broad one ("fractions") a long one.
- A code goes straight to the document: `pk 186`, `PK-0186`, `fo23`. Test Prep (`-TP`)
  and other versions of the same number show up together, and `WOB 7` gives the whole
  book followed by its chapters.
- Filters: document type, topic and level. With filters and no words, it lists
  everything that matches, in code order.
- Image search turns the reading into words and gives a small boost to the topics the
  reader named. Clicking one of the skill chips searches that skill alone.
- Search can only be as good as the export: documents with no tags, skills or keywords
  are found by title only. `build_library.py` prints how many there are.

## Costs

- **Cloudflare Pages and Access:** free at this size (Pages allows 500 deployments a
  month and 100,000 function requests a day; Access is free up to 50 users). Opening
  the page, opening a PDF and an image search each use a few function requests;
  typing searches runs in the browser and uses none.
- **R2:** free within 10 GB stored, 1 million writes and listings and 10 million reads
  a month, and R2 never charges for downloads. A library of about 1,200 PDFs is
  around 0.5 GB; the first upload is about 1,200 writes.
- **Image reading with Workers AI:** free within Workers AI's daily allowance (10,000
  "neurons" a day on the free plan). A photo read by Gemma 4 uses a small fraction of
  that, so a center's searches fit comfortably; once the day's allowance is used up,
  image search says so until the next day, and typed search keeps working.
- **Image reading with Claude:** the page shrinks each photo before sending it. With
  Haiku, one image costs about **$0.0005**, so **roughly 2,000 image searches per $1**.
  With `MODEL` set to `claude-sonnet-5-5` it's about 20 times that. The workspace spend
  limit caps either one.
- **GitHub:** free, public or private.

## Privacy and security

- No student information is in the library or the page. Image search sends only the
  photo; don't photograph anything with a student's full name on it. The reader is
  told never to repeat names, and nothing is stored.
- Secrets live only in Cloudflare: the Anthropic key (if used) as a secret in the
  Pages settings, nothing in this repo or the browser. With Workers AI there is no
  key at all, and the photo doesn't leave Cloudflare. The R2 upload key is used only on
  the center's computer, from the PowerShell window, and never saved.
- Every route verifies the Access sign-in token itself before reading the bucket or
  running a model (see How it works).
- The bucket has no public address. The PDF route looks up only document codes and
  answers `noindex`; the library route answers only `library.json`.
- `public/_headers` stops the page from contacting any other site, keeps it out of
  search engines and blocks other sites from framing it.
- Bindings and settings are for Production only, so a preview deployment (for
  example from a branch) can't reach the curriculum or the key.

## Tests

```
npm test                              # the search, the Access check, the reader and every route
python3 -m unittest discover tests    # the uploader, with a stand-in bucket
npm run browser-test                  # the page in a real browser (needs Playwright)
```

They run on `tests/sample_library.json`, a made-up library in the export's format. A
real `library.json` placed next to this README (it's ignored by git) adds a few
checks against it.
