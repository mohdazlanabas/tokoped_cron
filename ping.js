// ping.js — robust success rules for sites that return response=null (status 0)

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
const NAV_WAIT_UNTIL = "domcontentloaded"; // more tolerant than networkidle
const MAX_RETRIES = 4;
const JITTER_MS = [1200, 4000];
const POST_LOAD_SETTLE_MS = 2000;

// ---------- Helpers ----------
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const backoffMs = (attempt) => 1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);

function parseHostname(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
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

// Robust success rule: status ok OR (real DOM & title) OR hostname reached
function isOk({ status, bodyLen, title, finalHost, targetHost }) {
  const statusOk = status >= 200 && status < 400;
  const domOk = bodyLen > 1200 && title && title.trim().length > 0;
  const hostOk = finalHost && targetHost && finalHost.endsWith(targetHost);
  return Boolean(statusOk || (domOk && hostOk) || hostOk);
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(VISIT_TIMEOUT_MS);
  await page.emulateTimezone("Asia/Makassar");
  await page.setExtraHTTPHeaders({ "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7" });
  await page.setViewport({ width: 1366, height: 864 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );
  return page;
}

async function visitOnce(page, url) {
  const targetHost = parseHostname(url);
  const res = await page.goto(url, { waitUntil: NAV_WAIT_UNTIL, timeout: VISIT_TIMEOUT_MS });
  // Allow late JS hydration
  await sleep(POST_LOAD_SETTLE_MS);

  const status = res?.status?.() ?? res?.status ?? 0;
  const finalUrl = page.url();
  const finalHost = parseHostname(finalUrl);

  // Collect simple DOM signals
  const { bodyLen, title } = await page.evaluate(() => {
    const t = document.title || "";
    const txt = (document.body && document.body.innerText) ? document.body.innerText : "";
    return { title: t, bodyLen: txt.length };
  });

  return { status, finalHost, targetHost, bodyLen, title };
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

  // Stealth Chromium
  const browser = await puppeteerExtra.launch({
    headless: "new",
    ignoreHTTPSErrors: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--lang=id-ID",
      "--window-size=1366,864"
    ]
  });

  const page = await newPage(browser);

  const results = [];
  for (const url of urls) {
    let attempt = 0, ok = false, status = 0, errorMsg = "", lastProbe = null;

    while (attempt < MAX_RETRIES && !ok) {
      attempt++;
      try {
        lastProbe = await visitOnce(page, url);
        status = lastProbe.status || 0;
        ok = isOk(lastProbe);
        if (!ok) errorMsg = `Unhealthy: status=${status}, host=${lastProbe.finalHost}, body=${lastProbe.bodyLen}, title="${(lastProbe.title||"").slice(0,60)}"`;
      } catch (e) {
        errorMsg = e?.message || String(e);
      }
      if (!ok && attempt < MAX_RETRIES) await sleep(backoffMs(attempt));
    }

    results.push({
      timestamp: nowIso(),
      url,
      status,
      ok,
      attempts: attempt,
      error: ok ? "" : errorMsg
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