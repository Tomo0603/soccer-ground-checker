// src/check.mjs －－－－－－－－－－－－－－－－－－－－－－
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

/** ===== 共通ユーティリティ ===== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowJST() {
  const dt = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}/${pad(dt.getUTCMonth() + 1)}/${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

async function readJSON(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error(`FATAL: ${path.basename(file)} の読み込みエラー: ${e.message}`);
    process.exit(1);
  }
}

/** ページからラベル群（先頭数千文字）を取る（デバッグ用） */
async function getPageLabels(page, limit = 30) {
  const txt = await page.evaluate(() => document.body?.innerText || "");
  const labels = txt
    .split(/[\s\u3000]+/g)
    .filter(Boolean)
    .slice(0, limit);
  return labels.join(" | ");
}

/** 要素が見えていてクリック可能かチェック */
function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const styles = window.getComputedStyle(el);
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    styles.visibility !== "hidden" &&
    styles.display !== "none" &&
    styles.opacity !== "0";
  return visible;
}

/**
 * 画面内の「いずれかのテキストを含む」要素を探す。
 * 見出し・ボタン・リンク・div/span など幅広く対象にする。
 * （script, style, noscript は除外）
 */
async function findElementByTexts(page, texts) {
  const candidates = Array.isArray(texts) ? texts : [texts];

  const handle = await page.evaluateHandle((candTexts) => {
    const ban = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "META", "HEAD"]);
    const all = Array.from(document.querySelectorAll("body *")).filter(
      (el) => !ban.has(el.tagName)
    );

    // innerText を使って human-visible なテキスト比較
    const hit = all.find((el) => {
      if (!el || !isVisible(el)) return false;
      const t = el.innerText?.trim() || "";
      if (!t) return false;
      return candTexts.some((q) => t.includes(q));
    });

    return hit || null;

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const styles = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        styles.visibility !== "hidden" &&
        styles.display !== "none" &&
        styles.opacity !== "0" &&
        styles.display !== "contents"
      );
    }
  }, candidates);

  const el = await handle.asElement();
  if (!el) return null;
  return el;
}

/**
 * DOMの「テキスト署名」を取得：部分更新（PostBack、AJAX）でも検出できるよう body.innerText を短縮
 */
async function domSignature(page) {
  return await page.evaluate(() => {
    const t = document.body?.innerText || "";
    return t.replace(/\s+/g, " ").slice(0, 4000);
  });
}

/**
 * クリック→DOM変化待ち
 * - ASP.NET WebForms の __doPostBack や、Ajax 部分更新でも反応する
 * - URLが変わらないケースも考慮（waitForNavigation は使わない）
 */
async function clickByTextsWithDomChange(page, texts, timeout = 20000) {
  const el = await findElementByTexts(page, texts);
  if (!el) {
    throw new Error(`テキスト候補 ${JSON.stringify(texts)} が見つかりません`);
  }

  const before = await domSignature(page);

  // クリックは evaluate 内で scrollIntoView + click を実行
  await page.evaluate((node) => {
    node.scrollIntoView({ block: "center", inline: "center" });
    // a / button 以外でも click() を発火
    node.click();
  }, el);

  // DOMテキストが変わるのを待つ
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(300);
    const after = await domSignature(page);
    if (after && after !== before) return true;
  }

  // 変化がなかった場合は enter キー送出（フォーカスが必要な疑似ボタン対策）を一度だけ試す
  await page.keyboard.press("Enter");
  const start2 = Date.now();
  while (Date.now() - start2 < 5000) {
    await sleep(300);
    const after = await domSignature(page);
    if (after && after !== before) return true;
  }

  throw new Error(`テキスト候補 ${JSON.stringify(texts)} クリック後に画面変化がありません`);
}

/** ===== メイン処理 ===== */
async function main() {
  const targets = await readJSON(path.resolve("targets.json"));

  console.log(`実行時刻（JST）: ${nowJST()}`);
  console.log(`対象: 日曜日のみ、当月＋翌月`); // 既存ログ互換（実際の抽出条件は別途）

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--lang=ja-JP,ja",
    ],
    defaultViewport: { width: 1366, height: 900 },
  });

  let totalHits = 0;

  try {
    for (const t of targets) {
      const page = await browser.newPage();
      page.setDefaultTimeout(120000); // 遅いサイト対策
      page.setDefaultNavigationTimeout(120000);

      try {
        console.log(`[DEBUG] ${t.name} @ ${t.url}`);
        await page.goto(t.url, { waitUntil: "domcontentloaded" });

        // 画面冒頭のラベル出力（既存ログと似せる）
        const labels0 = await getPageLabels(page, 30);
        console.log(`[DEBUG] labels(first30): ${labels0}`);

        // 施設ごとの「文字列ステップ」を順に実行
        for (const step of t.facilityPath) {
          // 直前の署名（比較用）
          const beforeSig = await domSignature(page);

          let succeeded = false;
          let lastErr = null;

          // 候補群を上から順に試す
          for (const texts of [step]) {
            try {
              await clickByTextsWithDomChange(page, texts, 25000);
              succeeded = true;
              break;
            } catch (e) {
              lastErr = e;
            }
          }

          // 次画面ざっくりプレビュー
          const labels = await getPageLabels(page, 30);
          const joinedStep = Array.isArray(step) ? step.join("/") : String(step);
          console.log(`[DEBUG] after "${joinedStep}" -> ${labels}`);

          if (!succeeded) throw lastErr || new Error("unknown click error");

          // クリック前後の署名差を軽く出しておく（デバッグ用だがログは短め）
          const afterSig = await domSignature(page);
          if (beforeSig === afterSig) {
            // まれに同一署名になるケースもあるため少し待つ
            await sleep(800);
          }
        }

        // ★ 本来はここで「空き判定」を行う。
        // ひとまずデモ的に 0 件扱いにする（あなたの既存ロジックがあれば差し込んでOK）
        // const hits = await scanAvailability(page, t);
        const hits = 0;
        totalHits += hits;

      } catch (e) {
        if (/が見つかりません/.test(e.message)) {
          console.log(`× ${t.name}: ERROR ${e.message}`);
        } else if (/画面変化がありません/.test(e.message)) {
          console.log(`× ${t.name}: ERROR ${e.message}`);
        } else if (/Navigation timeout|timeout/i.test(e.message)) {
          console.log(`× ${t.name}: ERROR Navigation timeout`);
        } else {
          console.log(`× ${t.name}: ERROR ${e.message}`);
        }
      } finally {
        await page.close().catch(() => {});
      }
    }

    console.log(`ヒット数: ${totalHits}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
// －－－－－－－－－－－－－－－－－－－－－－－－－－－－－
