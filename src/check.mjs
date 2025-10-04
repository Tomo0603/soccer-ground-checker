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
const nowJST = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));

async function sendMail({ subject, text }) {
  if (!EMAIL_USER || !EMAIL_PASS || RECIPIENTS.length === 0) {
    console.warn("メール設定が未完了（EMAIL_USER/EMAIL_PASS/RECIPIENTS）。通知はスキップします。");
    return;
  }
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  await transporter.sendMail({ from: EMAIL_USER, to: RECIPIENTS.join(","), subject, text });
}

/* ================= ユーティリティ ================= */

function normalize(s) {
  return (s || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, " ")
    .trim();
}

async function dumpClickableTexts(page) {
  const frames = page.frames();
  const all = new Set();
  for (const f of frames) {
    try {
      const arr = await f.evaluate(() => {
        const grab = (n) => {
          const t = (n.innerText || n.textContent || "").replace(/\s+/g, " ").trim();
          const title = (n.getAttribute("title") || "").trim();
          const aria = (n.getAttribute("aria-label") || "").trim();
          const alt = (n.getAttribute("alt") || "").trim();
          return [t, title, aria, alt].filter(Boolean);
        };
        const tags = [
          "a","button","label","div","span","area","img","[role=button]","option","li","td"
        ];
        const nodes = Array.from(document.querySelectorAll(tags.join(",")));
        const out = [];
        for (const n of nodes) out.push(...grab(n));
        return out.filter(Boolean).map(s => s.length > 60 ? s.slice(0,60) : s);
      });
      arr.forEach(t => all.add(normalize(t)));
    } catch {}
  }
  return Array.from(all);
}

/**
 * できるだけ「リンク/ボタンっぽい要素」を優先してクリックする。
 * - href / onclick / role=button / タグ名の優先度で採点
 * - 同文言が複数ある場合にヘッダー等を押して画面が変わらない問題を回避
 * - 画面が変わらなければ数回リトライ
 */
async function clickByAnyText(page, texts, tags = ["a","button","[role=button]","area","img","option","label","span","div","li","td"]) {
  const wants = (Array.isArray(texts) ? texts : [texts]).map(normalize);
  const beforeURL = page.url();
  const beforeLabels = await dumpClickableTexts(page);

  // 3回まで「違う候補を」試す
  for (let attempt = 0; attempt < 3; attempt++) {
    let clicked = false;

    // すべてのフレームで候補収集 → スコア順にクリック
    for (const f of page.frames()) {
      const ok = await f.evaluate((wants, sel) => {
        function N(s){return (s||"").replace(/[Ａ-Ｚａ-ｚ０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0)).replace(/\s+/g," ").trim();}
        const nodes = Array.from(document.querySelectorAll(sel));

        // 候補の収集と採点
        const cands = [];
        for (const n of nodes) {
          const texts = [
            N(n.innerText||n.textContent||""),
            N(n.getAttribute("title")||""),
            N(n.getAttribute("aria-label")||""),
            N(n.getAttribute("alt")||""),
          ].filter(Boolean);

          if (!texts.length) continue;
          const hit = texts.some(t => wants.some(w => t.includes(w)));
          if (!hit) continue;

          const tag = (n.tagName || "").toLowerCase();
          const hasHref = !!n.getAttribute("href");
          const hasOnclick = !!n.getAttribute("onclick");
          const roleBtn = (n.getAttribute("role")||"").toLowerCase()==="button";
          const clickableStyle = (n.style && (n.style.cursor||"").includes("pointer")) ? 1 : 0;

          // タグ優先度: a > button > role=button > area/img > option/label > span/div/li/td
          const tagScore =
            tag==="a" ? 5 :
            tag==="button" ? 4 :
            roleBtn ? 3 :
            (tag==="area" || tag==="img") ? 2 :
            (tag==="option" || tag==="label") ? 1 :
            0;

          const score = (hasHref?5:0) + (hasOnclick?3:0) + tagScore + clickableStyle;
          cands.push({ n, score });
        }

        if (!cands.length) return false;

        // スコア降順でクリック
        cands.sort((a,b)=>b.score-a.score);
        const best = cands[Math.min(0 + (Math.random()<0.34?0:(Math.random()<0.67?0:1)), cands.length-1)]; // 同点が多い時のばらけ

        try {
          best.n.scrollIntoView({behavior:"instant", block:"center"});
          (best.n.click || best.n.dispatchEvent) &&
            (best.n.click ? best.n.click() : best.n.dispatchEvent(new MouseEvent("click",{bubbles:true})));
          return true;
        } catch { return false; }
      }, wants, tags.join(",")).catch(() => false);

      if (ok) { clicked = true; break; }
    }

    if (!clicked) {
      if (attempt === 2) throw new Error(`テキスト候補 ${JSON.stringify(wants)} が見つかりません`);
      await sleep(300);
      continue;
    }

    // URL変化 or DOMテキスト変化（AJAX） を待つ
    const domChanged = (async () => {
      for (let i=0;i<30;i++){ // ≒15秒
        await sleep(500);
        const now = await dumpClickableTexts(page);
        if (now.length !== beforeLabels.length ||
            now.slice(0,50).join("|") !== beforeLabels.slice(0,50).join("|")) return true;
      }
      return false;
    })();

    const navOk = await Promise.race([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12000 }).then(()=>true).catch(()=>false),
      page.waitForFunction((u)=>location.href!==u,{timeout:12000},beforeURL).then(()=>true).catch(()=>false),
      domChanged
    ]);

    if (navOk) return; // 成功
    // 失敗 → 次の候補でリトライ
  }

  throw new Error(`テキスト候補 ${JSON.stringify(wants)} クリック後に画面変化がありません`);
}

function buildSundayTokensJST(months = 2) {
  const base = nowJST();
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
      const mm = String(m).padStart(2,"0");
      const dd = String(day).padStart(2,"0");
      tokens.push(`${y}/${mm}/${dd}`, `${m}/${day}`, `${m}/${day}(日)`, `${y}-${mm}-${dd}`);
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
      const window = content.slice(Math.max(0, idx-150), Math.min(content.length, idx+150));
      if (kwRegex.test(window)) return true;
    }
  }
  return false;
}

async function getContent(page, selector, waitTimeout=45000) {
  await page.waitForFunction(() => document.body && (document.body.innerText||"").length > 200, { timeout: 20000 }).catch(()=>{});
  await page.waitForSelector(selector,{timeout:waitTimeout});
  return await page.$eval(selector, el => el.innerText || "");
}

async function collectTwoMonthsContent(page, selector) {
  let text = "";
  text += await getContent(page, selector);
  const nextLabels = ["翌月","次月","来月",">","＞","翌月へ","次へ"];
  for (const label of nextLabels) {
    try {
      await clickByAnyText(page,label);
      await sleep(800);
      text += "\n"+(await getContent(page,selector));
      break;
    } catch {}
  }
  return text;
}

/* ================= 施設チェック本体 ================= */

async function checkTarget(page, target) {
  const {name,url,resultSelector,keywords,kind,facilityPath=[]} = target;
  const start = Date.now();

  await page.goto(url,{waitUntil:"domcontentloaded",timeout:90000});
  const first = await dumpClickableTexts(page);
  console.log(`[DEBUG] ${name} @ ${url}\n[DEBUG] labels(first30): ${first.slice(0,30).join(" | ")}`);

  if (kind==="ekanagawa" || kind==="chigasaki") {
    for (const step of facilityPath) {
      await clickByAnyText(page,step);
      await sleep(500);
      const labels = await dumpClickableTexts(page);
      console.log(`[DEBUG] after "${Array.isArray(step)?step.join("/") : step}" -> ${labels.slice(0,30).join(" | ")}`);
    }
  }

  const content = await collectTwoMonthsContent(page,resultSelector);
  const hit = sundayHitFromText(content,keywords);
  const ms = Date.now()-start;
  return {name,url,hit,sample:content.slice(0,200),ms};
}

/* ================= メイン ================= */

async function main(){
  // targets.json はトップレベル「配列」想定
  let targets;
  try {
    const raw = await fs.readFile(targetsPath,"utf-8");
    targets = JSON.parse(raw);
    if (!Array.isArray(targets)) throw new Error("targets.json は配列である必要があります");
  } catch (e) {
    const msg = `targets.json の読み込みエラー: ${e.message}`;
    console.error("FATAL:", msg);
    await sendMail({subject:"⚠️ チェッカー設定エラー", text: msg});
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless:true,
    args:["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"]
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8" });
  await page.setRequestInterception(true);
  page.on("request",req=>{
    if(["image","font","stylesheet","media"].includes(req.resourceType())) return req.abort();
    req.continue();
  });

  const results=[];
  for(const t of targets){
    try{ results.push(await checkTarget(page,t)); }
    catch(e){ results.push({name:t.name,url:t.url,hit:false,error:e.message}); }
    await sleep(900);
  }
  await browser.close();

  const hits=results.filter(r=>r.hit);
  const body=[
    `実行時刻（JST）: ${nowJST().toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}`,
    `対象: 日曜日のみ、当月＋翌月`,
    `ヒット数: ${hits.length}`,
    "",
    ...results.map(r=>r.error?`× ${r.name}: ERROR ${r.error}`:`${r.hit?"✅":"—"} ${r.name} [${r.ms}ms]\n   例: ${r.sample.replace(/\s+/g," ").slice(0,100)}…`)
  ].join("\n");

  // ヒット0でも必ず通知
  await sendMail({subject:`⚽ 日曜空きチェック: ヒット${hits.length}件`, text: body});
  console.log(body);
}

main().catch(async e=>{
  console.error("FATAL:",e);
  try{ await sendMail({subject:"⚠️ チェッカー異常終了",text:String(e)});}catch{}
  process.exit(1);
});
