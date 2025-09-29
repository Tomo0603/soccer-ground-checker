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

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const RECIPIENTS = (process.env.RECIPIENTS || EMAIL_USER || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const todayJST = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));

async function sendMail({ subject, text }) {
  if (!EMAIL_USER || !EMAIL_PASS || RECIPIENTS.length === 0) {
    console.warn("メール設定が未完了。Secretsを確認してください。");
    return;
  }
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  await transporter.sendMail({ from: EMAIL_USER, to: RECIPIENTS.join(","), subject, text });
}

// ---------- ラベル可視化 ----------
async function dumpClickableTexts(page) {
  const frames = page.frames();
  const all = new Set();
  for (const f of frames) {
    try {
      const arr = await f.evaluate(() => {
        const tags = ["a","button","label","div","span"];
        const nodes = Array.from(document.querySelectorAll(tags.join(",")));
        return nodes
          .map(n => (n.textContent || "").replace(/\s+/g," ").trim())
          .filter(t => t && t.length <= 30);
      });
      arr.forEach(t => all.add(t));
    } catch {}
  }
  return Array.from(all);
}

// ---------- クリックユーティリティ ----------
function norm(s) {
  return (s || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, " ")
    .trim();
}

async function clickByAnyText(page, texts, tags = ["a","button","label","div","span"]) {
  const wants = Array.isArray(texts) ? texts.map(norm) : [norm(texts)];
  const frames = page.frames();
  const sel = tags.join(",");
  for (const f of frames) {
    const clicked = await f.evaluate((wants, sel) => {
      function normLocal(s){
        return (s || "")
          .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
          .replace(/\s+/g, " ")
          .trim();
      }
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const n of nodes) {
        const t = normLocal(n.textContent);
        if (wants.some(w => t.includes(w))) {
          n.scrollIntoView({behavior:"instant", block:"center"});
          n.click();
          return true;
        }
      }
      return false;
    }, wants, sel).catch(() => false);
    if (clicked) return;
  }
  throw new Error(`テキスト候補 ${JSON.stringify(wants)} が見つかりません`);
}

// ---------- 日曜トークン ----------
function buildSundayTokensJST(months = 2) {
  const base = todayJST();
  const tokens = [];
  const d = new Date(base);
  d.setHours(0,0,0,0);
  const end = new Date(d);
  end.setMonth(end.getMonth() + months + 1, 0);
  while (d <= end) {
    if (d.getDay() === 0) {
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      const mm = String(m).padStart(2, "0");
      const dd = String(day).padStart(2, "0");
      tokens.push(
        `${y}/${mm}/${dd}`, `${y}/${m}/${day}`,
        `${mm}/${dd}`, `${m}/${day}`,
        `${m}/${day}(日)`, `${mm}/${dd}(日)`,
        `${y}-${mm}-${dd}`, `${y}-${m}-${day}`
      );
    }
    d.setDate(d.getDate() + 1);
  }
  return Array.from(new Set(tokens));
}

function sundayHitFromText(content, keywords) {
  const toks = buildSundayTokensJST(2);
  const kw = (keywords && keywords.length ? keywords : ["空き","○","◯","空有"])
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const kwRegex = new RegExp(kw.join("|"), "i");
  for (const t of toks) {
    const idx = content.indexOf(t);
    if (idx >= 0) {
      const window = content.slice(Math.max(0, idx - 120), Math.min(content.length, idx + t.length + 120));
      if (kwRegex.test(window)) return true;
    }
  }
  return false;
}

// ---------- ページ処理 ----------
async function getContent(page, selector, waitTimeout = 45000) {
  await page.waitForFunction(() => document.body && document.body.innerText.length > 200, { timeout: 25000 }).catch(()=>{});
  await page.waitForSelector(selector, { timeout: waitTimeout });
  return await page.$eval(selector, el => el.innerText || "");
}

async function collectTwoMonthsContent(page, selector) {
  let text = "";
  text += await getContent(page, selector);
  const nextMonthLabels = ["翌月", "次月", "来月", ">", "＞", ">>", "翌月へ", "次へ"];
  for (const label of nextMonthLabels) {
    try {
      const beforeURL = page.url();
      await clickByAnyText(page, label);
      await Promise.race([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{}),
        page.waitForFunction((u) => location.href !== u, { timeout: 20000 }, beforeURL).catch(()=>{})
      ]);
      await sleep(600);
      text += "\n" + (await getContent(page, selector));
      break;
    } catch {}
  }
  return text;
}

async function checkTarget(page, target) {
  const { name, url, resultSelector, keywords, kind, facilityPath = [] } = target;
  const start = Date.now();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

  // 画面にあるラベルを最初にログ
  const firstList = await dumpClickableTexts(page);
  console.log(`[DEBUG] ${name} @ ${url}\n[DEBUG] labels(first 50): ${firstList.slice(0,50).join(" | ")}`);

  if (kind === "ekanagawa") {
    for (const step of facilityPath) {
      const beforeURL = page.url();
      await clickByAnyText(page, step);
      await Promise.race([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{}),
        page.waitForFunction((u) => location.href !== u, { timeout: 20000 }, beforeURL).catch(()=>{})
      ]);
      await sleep(600);
      // クリック後のラベルもログ
      const labels = await dumpClickableTexts(page);
      console.log(`[DEBUG] after "${Array.isArray(step)?step.join("/") : step}" -> labels(first 50): ${labels.slice(0,50).join(" | ")}`);
    }
  }

  const content = await collectTwoMonthsContent(page, resultSelector);
  const hit = sundayHitFromText(content, keywords);
  const ms = Date.now() - start;
  return { name, url, hit, sample: content.slice(0, 500), ms };
}

// ---------- メイン ----------
async function main() {
  const targets = JSON.parse(await fs.readFile(targetsPath, "utf-8"));
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--single-process"]
  });
  const page = await browser.newPage();

  // 軽量化
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image","font","stylesheet","media"].includes(type)) return req.abort();
    req.continue();
  });

  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7" });
  await page.setViewport({ width: 1366, height: 900 });

  const results = [];
  for (const t of targets) {
    try { results.push(await checkTarget(page, t)); }
    catch (e) { results.push({ name: t.name, url: t.url, hit: false, error: e.message }); }
    await sleep(1500);
  }
  await browser.close();

  const hits = results.filter(r => r.hit);
  const nowJST = todayJST().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const body = [
    `実行時刻（JST）: ${nowJST}`,
    `対象: 日曜日のみ、当月＋翌月`,
    `ヒット数: ${hits.length}`,
    "",
    ...results.map(r => r.error ? `× ${r.name}: ERROR ${r.error}` : `${r.hit ? "✅" : "—"} ${r.name} [${r.ms}ms]\n   例: ${r.sample.replace(/\s+/g," ").slice(0, 120)}…`)
  ].join("\n");

  await sendMail({ subject: `⚽ 日曜空きチェック: ヒット${hits.length}件`, text: body });
  console.log(body);
}

main().catch(async e => {
  console.error("FATAL:", e);
  try { await sendMail({ subject: "⚠️ チェッカー異常終了", text: String(e) }); } catch {}
  process.exit(1);
});
