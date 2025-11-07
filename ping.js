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
const REPORT_CSV = path.join(ARTIFACT_DIR, "visit_log.csv");
const REPORT_JSON = path.join(ARTIFACT_DIR, "visit_log.json");
const SUMMARY_TXT = path.join(ARTIFACT_DIR, "summary.txt");

const VISIT_TIMEOUT_MS = 60_000;
const WAIT_UNTIL = "networkidle2";
const MAX_RETRIES = 2;
const JITTER_MS = [800, 2500];

function isOk(status, content) {
  const statusOk = status >= 200 && status < 400;
  const bodyOk = content && content.length > 2000; // basic guard against bot-block blanks
  return statusOk && bodyOk;
}

function readUrls(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length === 0) return [];
  const header = lines[0].toLowerCase();
  if (!header.includes("url")) {
    throw new Error("The first line of urls.csv must contain a 'url' header.");
  }
  return lines.slice(1).map((l) => l.split(",")[0].trim());
}

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }

async function visitOnce(page, url) {
  const res = await page.goto(url, { waitUntil: WAIT_UNTIL, timeout: VISIT_TIMEOUT_MS });
  const status = res?.status() ?? 0;
  const html = await page.content();
  return { status, html };
}

async function run() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const csv = await readFile(CSV_PATH, "utf8");
  const urls = readUrls(csv);
  if (urls.length === 0) {
    console.error("No URLs found in urls.csv (after header).");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 864 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9,id;q=0.8" });

  const results = [];

  for (const url of urls) {
    let attempt = 0, ok = false, status = 0, errorMsg = "", lastHtml = "";
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
      if (!ok && attempt < MAX_RETRIES) await sleep(randInt(1000, 3000));
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
  const rows = results.map(r =>
    [r.timestamp, r.url, r.status, r.ok, r.attempts, `"${(r.error || "").replace(/"/g, '""')}"`].join(",")
  ).join("\n");
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

  // Always exit 0 so the email step can run without conditional gymnastics
  console.log("SUMMARY\n" + summary);
  process.exit(0);
}

run().catch(e => {
  console.error("Fatal error:", e);
  // still write a minimal summary so email has something
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, "summary.txt"),
      `Run crashed:\n${e?.message || String(e)}\n`,
      "utf8"
    );
  } catch {}
  process.exit(0);
});