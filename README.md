# Agile Strategy — Statement of Position (hosted app)

A branded, fillable Statement of Position that clients complete in the browser, with:

- **Google Places** address autofill (in-page)
- **Cotality** security-address verification (server-side proxy)
- **DocuSign** e-signature (server-side)
- **Google Drive** archiving of signed (and optionally unsigned) PDFs

The form works standalone (print → Save as PDF) even with the backend off. Turn the
backend on once hosted.

```
public/index.html              Statement of Position form
public/asb.html                Personal Statement of Financial Position (ASB-style)
public/disclosure.html         Adviser Disclosure Information (DocuSign-signable)
netlify/functions/
  property-lookup.js           Cotality proxy        → /api/property-lookup
  submit.js                    PDF + DocuSign send   → /api/submit  (serves all forms)
  docusign-webhook.js          Connect → Drive       → /api/docusign-webhook
  form-save.js                 Shared form save      → /api/form-save   (Netlify Blobs, PIN-aware)
  form-load.js                 Shared form load      → /api/form-load
  lib/docusign.js  lib/pdf.js  lib/drive.js  lib/logo.js
netlify.toml  package.json  .env.example
```

## Shared forms (adviser + client co-editing) + PIN

Both data forms support a shared link. With `ENABLE_BACKEND = true`, opening a form mints an
unguessable `?ref=...` id and autosaves to Netlify Blobs (no extra setup). Anyone with the
link opens the same in-progress form, so you can pre-fill or assist a client and they can
continue from where you left off. "Copy share link" is in the toolbar — the first time you
copy a link you're prompted to set a **PIN**, which is then required to open or edit that
form. Send the link and the PIN to the client by separate channels. Last write wins.

> Multiple advisers: anyone on your team (e.g. your loan analyst) who has the app URL can
> create and work on forms. There's no per-user login yet — the PIN protects individual
> client forms. Ask if you want a proper team sign-in layer.

---

## 1 · Deploy to Netlify

**Option A — Git (recommended):** push this folder to a repo, then in Netlify
"Add new site → Import from Git". Build command: *(none)*. Publish dir: `public`.
Functions dir: `netlify/functions` (already in `netlify.toml`).

**Option B — CLI:** `npm i -g netlify-cli` → `netlify deploy --prod` from this folder.

Netlify installs the `package.json` dependencies and bundles the functions automatically.
Add your custom domain (Site → Domain management), e.g. `forms.agilestrategy.co.nz`.

Then set `ENABLE_BACKEND = true` near the top of the `<script>` in `public/index.html`.

---

## 2 · Google Places (in-page address autofill)

In `public/index.html`, set:

```js
var ENABLE_ADDRESS_AUTOCOMPLETE = true;
var GOOGLE_MAPS_KEY = "AIza...";   // restricted to your domain
```

Create the key in Google Cloud Console: enable **Places API (New)** + **Maps JavaScript
API**, then restrict the key to your domain (HTTP referrers) and to those two APIs, and
set a quota cap. (See the earlier deploy guide for the click-path.)

---

## 3 · DocuSign (e-signature)

This uses **JWT Grant** (server-to-server, no user login per request).

1. Create a free developer account at developers.docusign.com and log into the
   **demo** environment first.
2. **Settings → Apps and Keys:**
   - Note your **Integration Key** (this is `DOCUSIGN_INTEGRATION_KEY`).
   - Note the **API Username / User ID** GUID (`DOCUSIGN_USER_ID`).
   - Under **Authentication**, add an **RSA keypair** and copy the **private key**
     (`DOCUSIGN_RSA_PRIVATE_KEY` — paste the whole PEM; if your host strips newlines,
     replace each newline with `\n`).
   - Add a **Redirect URI** (any https URL of yours; only needed for the one-time consent).
3. **Grant consent once** (so the app can act on your behalf). Open this URL in a
   browser, replacing the client id, and click *Accept*:
   ```
   https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=YOUR_INTEGRATION_KEY&redirect_uri=YOUR_REDIRECT_URI
   ```
   (The "page can't load" screen afterwards is expected — consent is recorded.)
4. Set the env vars (`DOCUSIGN_OAUTH_BASE=account-d.docusign.com` for demo).
   Set `DOCUSIGN_CC_EMAIL` / `DOCUSIGN_CC_NAME` to receive a copy + countersign.
5. **Going live:** promote the integration key to production (Apps and Keys → "Go Live"),
   then switch `DOCUSIGN_OAUTH_BASE` to `account.docusign.com` and re-run the consent URL
   against `account.docusign.com`.

Signature/date placement uses anchor strings baked into the PDF
(`**signature_1**`, `**date_1**`, etc.) — no fixed coordinates to maintain.

---

## 4 · Cotality (security-address verification)

1. From your Cotality / CoreLogic developer account, get your **API base URL** and **key**.
2. Set `COTALITY_API_BASE` and `COTALITY_API_KEY`.
3. Open `netlify/functions/property-lookup.js` and adjust the two `TODO` spots to match
   your contracted endpoint and response fields (the address-match / property-detail path
   and the field names for legal description + title). The function already normalises the
   result to `{ address, legalDescription, titleReference, propertyId }` for the form.

The key stays server-side; the browser only ever calls `/api/property-lookup`.

---

## 5 · Google Drive (archive PDFs)

1. In Google Cloud Console, create a **service account**; download its JSON key.
2. Put the whole JSON (stringified) into `GOOGLE_SERVICE_ACCOUNT_JSON`.
3. Create a Drive folder for signed docs, copy its id into `GOOGLE_DRIVE_FOLDER_ID`,
   and **share that folder with the service account's email** (Editor).
4. Filing the **signed** PDF: in DocuSign, **Settings → Connect** → add a listener
   (JSON format, event *Envelope Completed*) pointing to
   `https://YOUR-DOMAIN/api/docusign-webhook`. On completion the signed PDF is filed to Drive.
5. To also archive the **unsigned** submission, set `ARCHIVE_UNSIGNED=true`.

> Alternative: DocuSign's own native Google Drive connector can file signed docs without
> the webhook. Use whichever you prefer — the webhook gives you more control over naming.

---

## Flow summary

```
Client opens form → Google autofills address
   → "Verify with Cotality" populates the security address (/api/property-lookup)
   → client completes; totals auto-calc; entries autosave
   → "Submit for e-signature" (/api/submit)
        builds branded PDF → (optional Drive archive) → DocuSign envelope sent
   → client signs by email; you're CC'd / countersign
   → on completion, Connect webhook files the signed PDF to your Drive
```

## Notes / testing
- Everything server-side needs your real credentials to run; test in DocuSign **demo**
  first, then promote to production.
- `lib/pdf.js` renders a clean, branded signing document that **mirrors every field**
  the client completed — application summary, both applicants, employment, the full
  assets/liabilities and income/expenditure tables (with live totals), the loan structure,
  the complete declarations text with the client's ticked confirmations, and the checklist —
  followed by signature/date anchors. It builds from the form's `report` payload, so new
  fields you add to the form flow through automatically.
- Keep `.env` out of git (a `.gitignore` is included).
