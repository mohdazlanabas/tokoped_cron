import fs from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Settings ----------
const CSV_PATH = path.join(__dirname, "urls.csv");
const ARTIFACT_DIR = path.join(__dirname, "artifacts");
const FAILURE_DIR = path.join(ARTIFACT_DIR, "failures");
const REPORT_CSV = path.join(ARTIFACT_DIR, "visit_log.csv");
const REPORT_JSON = path.join(ARTIFACT_DIR, "visit_log.json");

// Network / browser behavior
const VISIT_TIMEOUT_MS = 60_000;       // per URL
const WAIT_UNTIL = "networkidle2";     // load strategy
const MAX_RETRIES = 2;                 // total attempts per URL
const JITTER_MS = [800, 2500];         // random delay between visits

// A simple success rule: 2xx/3xx response and non-empty content
function isOk(status, content) {
  const statusOk = status >= 200 && status < 400;
  const bodyOk = content && content.length > 2000; // avoid tiny bodies / blocks
  return statusOk && bodyOk;
}

// Create folders
fs.mkdirSync(FAILURE_DIR, { recursive: true });

// Read CSV (single column: url)
function readUrls(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length === 0) return [];

  // Expect header "url"
  const header = lines[0].toLowerCase();
  if (!header.includes("url")) {
    throw new Error("The first line of urls.csv must contain a 'url' header.");
  }

  return lines.slice(1).map((l) => {
    // support either plain URL or CSV with just one field
    const firstField = l.split(",")[0].trim();
    return firstField;
  });
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function visitOnce(page, url) {
  const res = await page.goto(url, { waitUntil: WAIT_UNTIL, timeout: VISIT_TIMEOUT_MS });
  const status = res?.status() ?? 0;
  const html = await page.content();
  return { status, html };
}

async function run() {
  // Read URL list
  const csv = await readFile(CSV_PATH, "utf8");
  const urls = readUrls(csv);

  if (urls.length === 0) {
    console.error("No URLs found in urls.csv (after header).");
    process.exit(1);
  }

  // Launch browser once
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();

  // Masquerade as a normal desktop Chrome
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 864 });
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8"
  });

  const results = [];

  for (const url of urls) {
    let attempt = 0;
    let ok = false;
    let status = 0;
    let errorMsg = "";
    let lastHtml = "";

    while (attempt < MAX_RETRIES && !ok) {
      attempt++;
      try {
        const { status: s, html } = await visitOnce(page, url);
        status = s;
        lastHtml = html;
        ok = isOk(status, lastHtml);
        if (!ok) errorMsg = `Unhealthy: status=${status}, html_len=${lastHtml?.length ?? 0}`;
      } catch (e) {
        errorMsg = e?.message || String(e);
      }

      if (!ok && attempt < MAX_RETRIES) {
        await sleep(randInt(1000, 3000)); // brief backoff before retry
      }
    }

    // Save failure evidence
    if (!ok) {
      const safe = url.replace(/[^a-z0-9]+/gi, "_").slice(0, 80);
      const pngPath = path.join(FAILURE_DIR, `${safe}_${Date.now()}.png`);
      try {
        await page.screenshot({ path: pngPath, fullPage: true });
      } catch {
        // ignore screenshot errors
      }
    }

    results.push({
      timestamp: nowIso(),
      url,
      status,
      ok,
      attempts: attempt,
      error: ok ? "" : errorMsg
    });

    // Random jitter between URLs to look human and avoid rate limits
    await sleep(randInt(JITTER_MS[0], JITTER_MS[1]));
  }

  await browser.close();

  // Write reports
  const header = "timestamp,url,status,ok,attempts,error\n";
  const rows = results
    .map((r) =>
      [
        r.timestamp,
        r.url,
        r.status,
        r.ok,
        r.attempts,
        `"${(r.error || "").replace(/"/g, '""')}"`
      ].join(",")
    )
    .join("\n");
  fs.writeFileSync(REPORT_CSV, header + rows, "utf8");
  fs.writeFileSync(REPORT_JSON, JSON.stringify(results, null, 2), "utf8");

  // Exit non-zero if any failure (so Alerts trigger)
  const anyFail = results.some((r) => !r.ok);
  if (anyFail) {
    console.error("One or more URLs failed. See artifacts/visit_log.csv and screenshots in artifacts/failures/.");
    process.exit(2);
  } else {
    console.log("All URLs visited successfully.");
    process.exit(0);
  }
}

run().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});