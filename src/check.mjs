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
const todayJST = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));

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

// ==== クリック候補を収集（デバッグ用） ====
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

// ==== テキスト一致クリック（全フレーム探索） ====
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

// ==== 当月＋翌月（2か月分）だけ内容取得 ====
async function collectTwoMonthsContent(page, selector) {
  let text = "";
  text += await getContent(page, selector);

  // 翌月に進めそうなら1回だけ
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
      break;
    } catch { /* 次の候補へ */ }
  }
  return text;
}

// ==== 「日曜日の空きのみ」を判定するフィルタ ====
// 直近2か月の「日曜日」の日付文字列候補を複数フォーマットで生成し、
// その近傍（±120文字）に空きキーワードがあるかをチェック。
function buildSundayTokensJST(months = 2) {
  const base = todayJST();
  const tokens = [];
  const d = new Date(base);
  d.setHours(0,0,0,0);

  // 2か月先の末日まで走査
  const end = new Date(d);
  end.setMonth(end.getMonth() + months + 1, 0); // 翌々月末
  while (d <= end) {
    if (d.getDay() === 0) { // 日曜
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
  const kw = (keywords && keywords.length ? keywords : ["空き","○","◯","空有"]).map(k => escapeRegExp(k));
  const kwRegex = new RegExp(kw.join("|"), "i");

  for (const t of toks) {
    const idx = content.indexOf(t);
    if (idx >= 0) {
      const start = Math.max(0, idx - 120);
      const end = Math.min(content.length, idx + t.length + 120);
      const window = content.slice(start, end);
      if (kwRegex.test(window)) return true;
    }
  }
  return false;
}

function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ====
