# Consignment tracker (Shree Tirupati Courier AWB search)

A local page for tracking Shree Tirupati Courier AWB numbers. It reuses the courier website's
own public AWB search. Nothing new is created upstream.

## Run it

Requires Node.js 18 or newer. There is nothing to install.

```bash
node server.js
# → open http://localhost:3000
```

Use another port with `PORT=8080 node server.js`.

You can also open `index.html` from disk or from VS Code Live Server (`http://127.0.0.1:5500`).
The page then calls the relay at the address in its `<meta name="awb-relay" content="http://localhost:3000">`
tag, so `server.js` still has to be running. If you start the relay on another port, change that tag.
When `server.js` serves the page itself, it blanks the tag and the page calls `/api/*` on the same origin.

## Deploy to Netlify

The same relay runs on Netlify as a serverless function, so nothing has to stay running on your computer.

| File | Role |
|---|---|
| `relay.js` | The courier logic (search, parsing, validation), shared by the two files below. |
| `server.js` | Local server: `node server.js`. |
| `netlify/functions/track.mjs` | Netlify Function serving `/api/track` and `/api/health`, with the same JSON as the local API. |
| `scripts/build-netlify.js` | Build step: writes `dist/index.html` with the relay address blanked, so the page calls `/api/track` on its own site. Only this file is published. |
| `netlify.toml` | Build command, publish folder, functions folder and basic security headers. |

**Option A: Netlify CLI (no Git remote needed)**

```bash
npm install -g netlify-cli
netlify login
netlify deploy --build           # first run: choose "Create & configure a new project"; gives a draft URL to test
netlify deploy --build --prod    # publish to the live URL
```

**Option B: Git (redeploys on every push)**

1. Push this repository to GitHub, GitLab or Bitbucket.
2. In Netlify choose **Add new project → Import an existing project** and pick the repository.
3. Set the production branch to `relay-server` (Project configuration → Build & deploy → Branches).
   Build command, publish folder and functions folder are read from `netlify.toml`; leave them as detected.

Check it by opening `https://<your-site>.netlify.app/?awb=171100087119` and
`https://<your-site>.netlify.app/api/health`.

Things to know about the hosted version:

* **It is public.** Anyone with the URL can search any AWB number, exactly as they can on the courier's own site.
  Share the address only with people who should have it. Netlify's password protection is a paid feature.
* **Each search is one function call.** A search normally takes about a second. The first one after the site has been
  idle also has to start the function, so it can take a couple of seconds longer. Netlify's documented limit for
  synchronous functions is 60 seconds, and some accounts report 10.
* **Opening `index.html` from disk still works** with `node server.js` running, as above. Only the build step changes the
  relay address, and it changes it in `dist/`, never in `index.html`.
* **Local test of the Netlify setup:** `npm run build`, then `npx netlify-cli dev --dir dist`.

## Why there is a small server

`shreetirupaticourier.net` doesn't send CORS headers, so a browser won't let a page from
`localhost` or `file://` read its responses. `server.js` makes the same requests the website's
"Enter AWB No. → GO" box makes, and returns the result to `index.html` as JSON.

## How the existing search works (and what the relay repeats)

| Step | Request | Notes |
|---|---|---|
| 1 | `GET /TopHeader.aspx` | Read the hidden `__VIEWSTATE`, `__VIEWSTATEGENERATOR` and `__EVENTVALIDATION` fields. The POST is rejected without them. Cached for 10 min and refreshed automatically if a POST is rejected. |
| 2 | `POST /TopHeader.aspx` (form-urlencoded) | `trackingno=<AWB[,AWB…]>`, `btnTrack=Go`, `networksearch=` plus the three hidden fields. Responds `302` to `/Frm_DocList.aspx?docnos=<server-encrypted token>`. |
| 3 | `GET /Frm_DocList.aspx?docnos=…` | One `<a target="I1" href="Frm_DocTrackWeb.aspx?docno=<encrypted>&Tmp=<n>">AWB</a>` per number. An empty list means no match. |
| 4 | `GET /Frm_DocTrackWeb.aspx?docno=…` | Booking and status. Fields are read from `#lblDocNumber`, `#txtFromCenter`, `#txtToCenter`, `#txtDate`, `#txtReceiver`, `#lblStatus` and `#tblTrack`. |

* **Authentication:** none. No login, API key, token header or session cookie is needed.
* **Tokens:** `docno` and `docnos` are encrypted by the server, so steps 1–2 can't be skipped.
  `Tmp` is only a cache-buster.
* **Validation rule (the site's own):** each AWB is exactly 12 digits. Several are joined with commas.

## Local API

`GET /api/track?awb=171100087119,171100099999` (commas, spaces or semicolons; at most 25)

```json
{
  "ok": true,
  "query": ["171100087119"],
  "officialUrl": "https://www.shreetirupaticourier.net/Frm_DocList.aspx?docnos=…",
  "summary": { "total": 1, "found": 1, "notFound": 0, "errors": 0 },
  "results": [{
    "awb": "171100087119",
    "found": true,
    "hasBooking": true,
    "booking": { "docNo": "171100087119", "fromCenter": "MUMBAI-VASAI (E)-NAVGHAR", "toCenter": "MUMBAI",
                 "bookedAt": "16-11-26 - 08:10 PM", "consignee": "…" },
    "status":  { "code": "delivered", "text": "Delivered On Dated 17-11-26 By MUMBAI-KURLA (W)", "date": "17-11-26" },
    "contact": { "text": "For Any Query, Contact To -- 77188 49943 …", "phones": ["77188 49943"] },
    "history": { "headers": null, "rows": [] },
    "detailUrl": "https://www.shreetirupaticourier.net/Frm_DocTrackWeb.aspx?docno=…"
  }],
  "fetchedAt": "2026-11-19T16:21:32.000Z",
  "tookMs": 840
}
```

`status.code` is one of `delivered`, `out_for_delivery`, `in_progress`, `returned`, `exception` or `unknown`.
It is derived from the status text.

The courier's site gives one of three answers for a number, and the relay keeps them apart:

| Site shows | `found` | `hasBooking` | Page shows |
|---|---|---|---|
| Booking details and a status | `true` | `true` | Route, booking date, status, consignee, help desk |
| A status scan but no booking (blank origin, destination and date) | `true` | `false` | The status, with a note that there are no booking details |
| Nothing | `false` | `false` | "Not found" |

A number whose detail page failed to load has `reason: "error"`, and the other numbers are still returned.
`contact.phones` comes from the hand-typed help-desk line. All-zero placeholders are dropped, and the same
number typed with different spacing is listed once.

Errors use the shape `{ "ok": false, "error": { "code", "message" } }`:
`400` for `EMPTY`, `INVALID_AWB` or `TOO_MANY`; `502` when the site is unreachable, rejects the
search or its markup changed; `504` when it is too slow.

`GET /api/health` returns `{ ok: true, upstream }`.

## Things to know

* The relay reads HTML by element id. If the courier redesigns those pages, the parsing in
  `parseDetail()` / `parseDocList()` in `relay.js` is the one place to update. It applies to both the local
  server and the Netlify Function.
* On the live site, `js/FunctionLib2.js` has a syntax error, so `ValidateTracking()` and the
  digits-only key filter never load, and the form submits unchecked. This page applies the same
  12-digit rule itself.
* The relay listens on `127.0.0.1` only, and allows browser calls only from `file://` and
  `localhost` origins.
