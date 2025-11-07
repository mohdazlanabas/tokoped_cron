// ping.js — stealth + locale + longer timeouts + relaxed success rule

import fs from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteerExtra.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Settings ----------
const CSV_PATH = path.join(__dirname, "urls.csv");
const ARTIFACT_DIR = path.join(__dirname, "artifacts");
const REPORT_CSV = path.join(ARTIFACT_DIR, "visit_log.csv");
const REPORT_JSON = path.join(ARTIFACT_DIR, "visit_log.json");
const SUMMARY_TXT = path.join(ARTIFACT_DIR, "summary.txt");

// Tuned for marketplaces
const VISIT_TIMEOUT_MS = 120_000;
const WAIT_UNTIL = "networkidle2";
const MAX_RETRIES = 4;
const JITTER_MS = [1200, 4000];
const POST_LOAD_SETTLE_MS = 2500;

// Success = HTTP 2xx/3xx (don’t require big HTML; many sites hydrate via JS)
function isOk(status) {
  return status >= 200 && status < 400;
}

// CSV reader (header: url)
function readUrls(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (!lines.length) return [];
  if (!lines[0].toLowerCase().includes("url"))
    throw new Error("The first line of urls.csv must contain a 'url' header.");
  return lines.slice(1).map((l) => l.split(",")[0].trim());
}

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const backoffMs = (attempt) => 1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);

async function newPage(browser) {
  const page = await browser.newPage();
  // Indonesia-like environment
  await page.emulateTimezone("Asia/Makassar");
  await page.setExtraHTTPHeaders({ "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7" });
  await page.setViewport({ width: 1366, height: 864 });
  // Realistic UA
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );
  return page;
}

async function visitOnce(page, url) {
  const res = await page.goto(url, { waitUntil: WAIT_UNTIL, timeout: VISIT_TIMEOUT_MS });
  await page.waitForTimeout(POST_LOAD_SETTLE_MS);
  const status = res?.status() ?? 0;
  return { status };
}

async function run() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const csv = await readFile(CSV_PATH, "utf8");
  const urls = readUrls(csv);
  if (!urls.length) {
    const msg = "No URLs found in urls.csv (after header).";
    console.error(msg);
    fs.writeFileSync(SUMMARY_TXT, `${msg}\n`, "utf8");
    return;
  }

  // Use puppeteer-extra to launch with stealth
  const browser = await puppeteerExtra.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--lang=id-ID"
    ],
    // executablePath optional; default Chromium is fine in Actions
  });

  const page = await newPage(browser);

  const results = [];
  for (const url of urls) {
    let attempt = 0, ok = false, status = 0, errorMsg = "";

    while (attempt < MAX_RETRIES && !ok) {
      attempt++;
      try {
        const out = await visitOnce(page, url);
        status = out.status;
        ok = isOk(status);
        if (!ok) errorMsg = `Unhealthy: status=${status}`;
      } catch (e) {
        errorMsg = e?.message || String(e);
      }
      if (!ok && attempt < MAX_RETRIES) await sleep(backoffMs(attempt));
    }

    results.push({
      timestamp: nowIso(),
      url, status, ok, attempts: attempt, error: ok ? "" : errorMsg
    });

    await sleep(randInt(JITTER_MS[0], JITTER_MS[1]));
  }

  await browser.close();

  // Reports
  const header = "timestamp,url,status,ok,attempts,error\n";
  const rows = results
    .map(r => [r.timestamp, r.url, r.status, r.ok, r.attempts, `"${(r.error||"").replace(/"/g,'""')}"`].join(","))
    .join("\n");
  fs.writeFileSync(REPORT_CSV, header + rows, "utf8");
  fs.writeFileSync(REPORT_JSON, JSON.stringify(results, null, 2), "utf8");

  const total = results.length;
  const success = results.filter(r => r.ok).length;
  const fail = total - success;
  const failList = results.filter(r => !r.ok).map(r => `- ${r.url} (status ${r.status})`).join("\n");
  const summary = [
    `Daily Browser Visit Summary`,
    `Run time (UTC): ${nowIso()}`,
    `Total URLs: ${total}`,
    `Successful: ${success}`,
    `Unsuccessful: ${fail}`,
    fail > 0 ? `\nFailures:\n${failList}` : ``,
  ].join("\n");
  fs.writeFileSync(SUMMARY_TXT, summary.trim() + "\n", "utf8");

  console.log("SUMMARY\n" + summary);
}

run().catch((e) => {
  console.error("Fatal error:", e);
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, "summary.txt"), `Run crashed:\n${e?.message || String(e)}\n`, "utf8");
  } catch {}
});