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

// Login credentials (optional - from environment variables)
const TOKOPEDIA_EMAIL = process.env.TOKOPEDIA_EMAIL || "";
const TOKOPEDIA_PASSWORD = process.env.TOKOPEDIA_PASSWORD || "";
const REQUIRE_LOGIN = TOKOPEDIA_EMAIL && TOKOPEDIA_PASSWORD;

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

async function loginToTokopedia(page) {
  console.log("Attempting to login to Tokopedia...");

  try {
    // Navigate to Tokopedia seller login
    // Adjust URL based on actual seller login page
    await page.goto("https://www.tokopedia.com/login", { waitUntil: NAV_WAIT_UNTIL, timeout: VISIT_TIMEOUT_MS });
    await sleep(3000);

    // Wait for email/phone input field
    // These selectors may need adjustment based on Tokopedia's actual HTML
    const emailSelector = 'input[type="text"], input[type="email"], input[name="email"], input[placeholder*="email"], input[placeholder*="Email"]';
    await page.waitForSelector(emailSelector, { timeout: 10000 });

    // Fill in email/phone
    await page.type(emailSelector, TOKOPEDIA_EMAIL, { delay: 100 });
    await sleep(1000);

    // Click next/continue button or find password field
    const passwordSelector = 'input[type="password"], input[name="password"]';

    // Some sites show password field after clicking next
    const nextButton = await page.$('button[type="submit"], button:has-text("Selanjutnya"), button:has-text("Next")');
    if (nextButton) {
      await nextButton.click();
      await sleep(2000);
    }

    // Wait for password field and fill it
    await page.waitForSelector(passwordSelector, { timeout: 10000 });
    await page.type(passwordSelector, TOKOPEDIA_PASSWORD, { delay: 100 });
    await sleep(1000);

    // Submit login form
    const loginButton = 'button[type="submit"], button:has-text("Masuk"), button:has-text("Login")';
    await page.click(loginButton);

    // Wait for navigation after login
    await sleep(5000);

    // Check if OTP is required
    const currentUrl = page.url();
    if (currentUrl.includes('otp') || currentUrl.includes('verification')) {
      console.log("⚠️  OTP/2FA detected. Please enter OTP manually within 60 seconds...");
      console.log("Current URL:", currentUrl);

      // Wait 60 seconds for manual OTP entry (only works in headful mode)
      // For headless in GitHub Actions, you may need to handle this differently
      await sleep(60000);
    }

    // Verify login success
    await sleep(3000);
    const finalUrl = page.url();

    if (finalUrl.includes('login')) {
      throw new Error("Login failed - still on login page");
    }

    console.log("✓ Login successful!");
    return true;

  } catch (error) {
    console.error("Login failed:", error.message);
    throw new Error(`Login failed: ${error.message}`);
  }
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

  // Login if credentials are provided
  if (REQUIRE_LOGIN) {
    try {
      await loginToTokopedia(page);
      console.log("Logged in successfully. Will now visit seller URLs...\n");
    } catch (loginError) {
      console.error("Failed to login:", loginError.message);
      const errorSummary = `Login failed: ${loginError.message}\nCannot visit authenticated URLs without login.`;
      fs.writeFileSync(SUMMARY_TXT, errorSummary, "utf8");
      await browser.close();
      return;
    }
  } else {
    console.log("No login credentials provided. Visiting public URLs only.\n");
  }

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