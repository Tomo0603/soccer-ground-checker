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

// ==== フレーム横断でクリック候補を収集（デバッグ用） ====
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
  return Array.from(all).slice(0, 200);
}

// ==== $x 代替：フレーム横断で「テキスト一致」クリック ====
async function clickByText(page, text, tags = ["a","button","label","div","span"]) {
  const frames = page.frames();
  const sel = tags.join(",");
  for (const f of frames) {
    const clicked = await f.evaluate((text, sel) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      const target = nodes.find(n => (n.textContent || "").replace(/\s+/g," ").trim().includes(text));
      if (target) { target.scrollIntoView({behavior:"instant", block:"center"}); target.click(); return true; }
      return false;
    }, text, sel).catch(() => false);
    if (clicked) return;
  }
  throw new Error(`テキスト "${text}" の要素が見つかりません`);
}

// ==== コンテンツ読み取り（待機込み） ====
async function getContent(page, selector, waitTimeout = 45000) {
  await page.waitForFunction(
    () => document.body && document.body.innerText && document.body.innerText.length > 200,
    { timeout: 25000 }
  ).catch(()=>{});
  await page.waitForSelector(selector, { timeout: waitTimeout });
  return await page.$eval(selector, el => el.innerText || "");
}

// ==== 「当月＋翌月」の2か月分だけ収集 ====
async function collectTwoMonthsContent(page, selector) {
  let text = "";
  text += await getContent(page, selector);

  // 翌月に進めそうなら1回だけ進む（候補語を順に試す）
  const nextMonthLabels = ["翌月", "次月", "来月", ">", "＞", ">>", "翌月へ", "次へ"];
  for (const label of nextMonthLabels) {
    try {
      const beforeURL = page.url();
      await clickByText(page, label);
      await Promise.race([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(()=>{}),
        page.waitForFunction((u) => location.href !== u || document.readyState === "complete", { timeout: 20000 }, beforeURL).catch(()=>{})
      ]);
      await sleep(600);
      text += "\n" + (await getContent(page, selector));
      break; // 1回だけ
    } catch {
      // 次の候補へ
    }
  }
  return text;
}

// ==== 対象施設チェック ====
async function checkTarget(page, target) {
  const { name, url, resultSelector, keywords, kind, facilityPath = [] } = target;
  const start = Date.now();
  const navTimeout = 120000;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });

  // 初期ラベルをログ（facilityPathの表記調整に使う）
  const firstList = await dumpClickableTexts(page);
  console.log(`[DEBUG] ${name} @ ${url}\n[DEBUG] Available labels (first 40): ${firstList.slice(0,40).join(" | ")}`);

  if (kind === "ekanagawa") {
    for (const step of facilityPath) {
      const beforeURL = page.url();
      await clickByText(page, step);
      await Promise.race([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(()=>{}),
        page.waitForFunction((u) => location.href !== u || document.readyState === "complete", { timeout: 20000 }, beforeURL).catch(()=>{})
      ]);
      const labels = await dumpClickableTexts(page);
      console.log(`[DEBUG] After click "${step}" labels (first 40): ${labels.slice(0,40).join(" | ")}`);
      await sleep(800);
    }
  }

  // ★ 当月＋翌月の2か月分だけ読み取る
  const content = await collectTwoMonthsContent(page, resultSelector);

  const hit = (keywords || ["空き", "○", "◯"]).some(k => content.includes(k));
  const ms = Date.now() - start;
  return { name, url, hit, sample: content.slice(0, 500), ms };
}

// ==== メイン ====
async function main() {
  const targetsRaw = await fs.readFile(targetsPath, "utf-8");
  const targets = JSON.parse(targetsRaw);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--single-process"]
  });
  const page = await browser.newPage();

  // UA / 言語ヘッダ / タイムアウト
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7" });
  await page.setViewport({ width: 1366, height: 900 });
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);

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

  // JST基準の曜日（0=日）
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
