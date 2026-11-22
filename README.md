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

`server.js` serves the whole site, so the other pages are at `http://localhost:3000/about.html`, `/contact.html`
and so on. What it serves (and what the Netlify build publishes) is every `*.html` page in the project folder,
everything in `assets/`, and `robots.txt` / `sitemap.xml`. Nothing else, so `server.js`, `relay.js` and this README
are never exposed.

You can also open `index.html` from disk or from VS Code Live Server (`http://127.0.0.1:5500`).
The page then calls the relay at the address in its `<meta name="awb-relay" content="http://localhost:3000">`
tag, so `server.js` still has to be running. If you start the relay on another port, change that tag.
When `server.js` serves the page itself, it blanks the tag and the page calls `/api/*` on the same origin.
The other pages work from disk too; only the contact form needs `server.js` (see [Contact form](#contact-form)).

## Pages and files

| Page | File | What it is |
|---|---|---|
| Tracker (home) | `index.html` | The AWB search. |
| About Us | `about.html` | What the tracker does, how it works and who runs it. |
| Contact Us | `contact.html` | Contact form and contact details. |
| Disclaimer | `disclaimer.html` | The limits of the tracking information. |
| Privacy Policy | `privacy-policy.html` | What is handled, stored and shared. |
| Terms & Conditions | `terms-and-conditions.html` | Terms of use. |

All styles and scripts are in `assets/`. The HTML pages contain no inline `<style>`, no inline `<script>` code and no
`style=""` attributes, so keep it that way when you edit them.

| File | Used by | Contents |
|---|---|---|
| `assets/site.css` | every page | Colour and type tokens, header, footer, buttons, panels, and the About, Contact and legal-page components. |
| `assets/tracker.css` | `index.html` | The search box, result slips and route strip. |
| `assets/site.js` | every page | Keeps the footer year current. |
| `assets/tracker.js` | `index.html` | The tracker itself (calls `/api/track`). |
| `assets/contact.js` | `contact.html` | Contact form validation and sending. |

The header and footer are repeated in each page (there is no build step that assembles pages), so when you add or
rename a link, change it in all six. The link for the page you are on carries `aria-current="page"`.

## Deploy to Netlify

The same relay runs on Netlify as a serverless function, so nothing has to stay running on your computer.

| File | Role |
|---|---|
| `relay.js` | The courier logic (search, parsing, validation), shared by the two files below. |
| `server.js` | Local server: `node server.js`. |
| `netlify/functions/track.mjs` | Netlify Function serving `/api/track` and `/api/health`, with the same JSON as the local API. |
| `scripts/build-netlify.js` | Build step: writes `dist/` with every `*.html` page and `assets/`, and blanks the relay address in `index.html`, so the page calls `/api/track` on its own site. Only these files are published. It also warns about any `[Placeholder]` left in a page (see [Before you go live](#before-you-go-live)). |
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

Check it by opening `https://<your-site>.netlify.app/?awb=171100087119`,
`https://<your-site>.netlify.app/api/health` and `https://<your-site>.netlify.app/about.html`.

Things to know about the hosted version:

* **It is public.** Anyone with the URL can search any AWB number, exactly as they can on the courier's own site.
  Share the address only with people who should have it. Netlify's password protection is a paid feature.
* **Each search is one function call.** A search normally takes about a second. The first one after the site has been
  idle also has to start the function, so it can take a couple of seconds longer. Netlify's documented limit for
  synchronous functions is 60 seconds, and some accounts report 10.
* **Opening `index.html` from disk still works** with `node server.js` running, as above. Only the build step changes the
  relay address, and it changes it in `dist/`, never in `index.html`.
* **Local test of the Netlify setup:** `npm run build`, then `npx netlify-cli dev --dir dist`.

## Contact form

`contact.html` is a [Netlify Forms](https://docs.netlify.com/forms/setup/) form. The page carries `data-netlify="true"`
and a hidden honeypot field, and `assets/contact.js` checks the fields and posts them to the site (`POST /`). There is
nothing to install and no key or secret to configure.

After the first deploy:

1. Open the project's **Forms** page in Netlify. If it offers to **enable form detection**, do that and redeploy once.
   (Netlify finds forms by reading the published HTML.)
2. To get an email for every message, go to **Forms → Form notifications → Add notification → Email notification** and
   pick the `contact` form. Messages are also kept in the **Forms** inbox.

Good to know:

* **Spam** is cut by the honeypot field and Netlify's own spam filtering. Netlify limits the number of submissions per
  month on its free plan, so check its pricing page if you expect many.
* **Without JavaScript** the browser validates and posts the form itself, and Netlify shows its default thank-you page.
* **Locally** (`node server.js`) there is no mail service. The form is accepted and the message is *printed in the
  terminal*, so you can try the whole flow. Nothing is stored or sent. From disk or Live Server the post has nowhere to
  go, and the page shows its "message wasn't sent" notice.
* **Not on Netlify?** Change the `fetch('/', …)` call in `assets/contact.js` to your own form endpoint.

## Before you go live

The About, Contact, Disclaimer, Privacy Policy and Terms pages contain `[Placeholders]` for business details that
aren't in this project. Replace each one with find-and-replace across the `*.html` files (the same text appears on
several pages):

| Placeholder | What to put |
|---|---|
| `[Business Name]` | Who runs the site (legal or trading name). |
| `[Support Email]` | The address that should receive messages. |
| `[Phone Number]` | The phone number for the contact page. |
| `[Business Address]` | Registered or postal address. |
| `[Business Hours]` | For example "Mon–Sat, 10:00 am – 6:00 pm IST". |
| `[City]` | The city whose courts have jurisdiction (Terms, "Governing law"). |
| `[Grievance Officer Name]` | Your grievance officer (Privacy Policy). |

`npm run build`, and every Netlify deploy, prints a warning listing any placeholder still left and the pages it is on.
It doesn't stop the build.

Also check:

* **Who runs the site.** The pages describe AWB Tracker as an independent tool that relays the courier's public
  tracking (as the "official page" wording on the tracker already does), hosted on Netlify, with fonts from Google
  Fonts. If the courier itself runs the site, or it is hosted elsewhere, edit the "we are not the courier" and hosting
  sentences in the About, Disclaimer, Terms and Privacy pages. The footer's "© Tirupati Courier Services Pvt. Ltd." is
  unchanged from before.
* **Privacy Policy accuracy.** It says the site sets no cookies and uses no analytics or advertising. If you add
  analytics, ads or other third-party services, update the policy first.
* **Legal review.** The Disclaimer, Privacy Policy and Terms are plain-language general text, not legal advice. Have them
  reviewed (especially governing law, liability and the grievance-officer details) before relying on them.
* **Search listings.** Every page has a canonical link to `https://tirupaticourier.in/…`, and `sitemap.xml` lists the six
  pages (`robots.txt` points to it). When you add a page, add it to `sitemap.xml` and give it a canonical link. The five
  new pages have their own title and meta description; `index.html` still has its original title and no meta
  description. The canonical links use the `.html` addresses, so don't turn on Netlify's "Pretty URLs" setting, which
  would redirect `/about.html` to `/about`.

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
