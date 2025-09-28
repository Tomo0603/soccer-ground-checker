import puppeteer from "puppeteer";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const targetsPath = path.join(__dirname, "..", "data", "targets.json");

// ==== 通知設定 ====
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const RECIPIENTS = (process.env.RECIPIENTS || EMAIL_USER || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// ==== ユーティリティ ====
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function sendMail({ subject, text }) {
  if (!EMAIL_USER || !EMAIL_PASS || RECIPIENTS.length === 0) {
    console.warn("メール設定が未完了。ENV/Secretsを確認してください。");
    return;
  }
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  await transporter.sendMail({
    from: EMAIL_USER,
    to: RECIPIENTS.join(","),
    subject,
    text,
  });
}

async function clickByText(page, text, tag = "a") {
  const xp = `//${tag}[contains(normalize-space(.), "${text}")]`;
  const [el] = await page.$x(xp);
  if (!el) throw new Error(`テキスト "${text}" の要素が見つかりません`);
  await el.click();
}

async function checkTarget(page, target) {
  const { name, url, resultSelector, keywords, kind, facilityPath = [] } = target;
  const start = Date.now();
  const navTimeout = 45000, waitTimeout = 25000;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });

  if (kind === "ekanagawa") {
    for (const step of facilityPath) {
      try {
        await page.waitForSelector("body", { timeout: 5000 });
        await clickByText(page, step, "a");
        await page.waitForNetworkIdle?.({ idleTime: 500, timeout: 10000 }).catch(()=>{});
      } catch (e) {
        try { await clickByText(page, step, "button"); }
        catch { try { await clickByText(page, step, "label"); }
        catch { throw e; } }
      }
    }
    await page.waitForSelector(resultSelector, { timeout: waitTimeout });
    const content = await page.$eval(resultSelector, el => el.innerText || "");
    const hit = (keywords || ["空き", "○", "◯"]).some(k => content.includes(k));
    const ms = Date.now() - start;
    return { name, url, hit, sample: content.slice(0, 500), ms };
  }

  if (kind === "chigasaki") {
    await page.waitForSelector(resultSelector, { timeout: waitTimeout });
    const content = await page.$eval(resultSelector, el => el.innerText || "");
    const hit = (keywords || ["空き", "○", "◯"]).some(k => content.includes(k));
    const ms = Date.now() - start;
    return { name, url, hit, sample: content.slice(0, 500), ms };
  }

  await page.waitForSelector(resultSelector, { timeout: waitTimeout });
  const content = await page.$eval(resultSelector, el => el.innerText || "");
  const hit = (keywords || ["空き", "○", "◯"]).some(k => content.includes(k));
  const ms = Date.now() - start;
  return { name, url, hit, sample: content.slice(0, 500), ms };
}

async function main() {
  const targetsRaw = await fs.readFile(targetsPath, "utf-8");
  const targets = JSON.parse(targetsRaw);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
  const page = await browser.newPage();

  const results = [];
  try {
    for (const t of targets) {
      try {
        const r = await checkTarget(page, t);
        results.push(r);
      } catch (e) {
        results.push({ name: t.name, url: t.url, hit: false, error: e.message });
      }
      await sleep(2000 + Math.random() * 2000);
    }
  } finally {
    await browser.close();
  }

  const hits = results.filter(r => r.hit);

  // JST基準の曜日を取得（0=日,1=月,...）
  const now = new Date();
  const dayJST = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" })).getDay();
  const nowJST = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  const reportLines = results.map(r => {
    if (r.error) return `× ${r.name}（${r.url}）: ERROR ${r.error}`;
    return `${r.hit ? "✅" : "—"} ${r.name}（${r.url}）\n   例: ${r.sample.replace(/\s+/g, " ").slice(0, 140)}…`;
  });
  const body = [`実行時刻（JST）: ${nowJST}`, "", ...reportLines].join("\n");

  if (hits.length > 0 && dayJST === 0) {
    await sendMail({ subject: `⚽ 空き検知（日曜）: ${hits.length}件`, text: body });
  } else {
    console.log(body);
  }
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try { await sendMail({ subject: "⚠️ チェッカー異常終了", text: String(e) }); } catch {}
  process.exit(1);
});
