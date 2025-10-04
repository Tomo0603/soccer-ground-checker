// src/check.mjs  ── Puppeteer + メール通知（自治体遷移を強化 / XPath不使用 / コピペ置換用）
import 'dotenv/config.js';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import nodemailer from 'nodemailer';

/* ========= ユーティリティ ========= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanWait = async (min = 200, max = 800) =>
  sleep(Math.floor(Math.random() * (max - min + 1)) + min);

const ROOT = path.resolve(process.cwd());
const TARGETS_PATH = path.join(ROOT, 'data', 'targets.json');
const CACHE_PATH = path.join(ROOT, 'data', 'notified.json');

/* 時刻フォーマット（ログ用） */
function nowJST() {
  return dayjs().format('YYYY/MM/DD HH:mm:ss');
}

/* 文字を含む <a> をクリック（相対/絶対どちらも対応） */
async function clickLinkByText(page, text) {
  const href = await page.evaluate((t) => {
    const links = Array.from(document.querySelectorAll('a'));
    const target = links.find((a) => (a.textContent || '').replace(/\s+/g, ' ').includes(t));
    if (!target) return null;
    return target.getAttribute('href') || target.href || null;
  }, text);

  if (!href) return false;

  if (/^https?:\/\//i.test(href)) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  } else {
    await page.evaluate((t) => {
      const links = Array.from(document.querySelectorAll('a'));
      const target = links.find((a) => (a.textContent || '').replace(/\s+/g, ' ').includes(t));
      if (target) target.click();
    }, text);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
  }
  return true;
}

/* 「検索/再検索/さがす」ボタンを押す */
async function clickSearchButton(page) {
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    const re = /検索|再検索|さがす|検索する/;
    const target = btns.find((el) => {
      const t = (el.textContent || '').trim();
      const v = (el.getAttribute('value') || '').trim();
      return re.test(t) || re.test(v);
    });
    if (target) { target.click(); return true; }
    return false;
  });
  if (clicked) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  return clicked;
}

/* 行内に「申込」ボタンがあるか */
async function rowHasApply(row) {
  return await row.evaluate((el) => {
    const cand = Array.from(el.querySelectorAll('a, button'));
    return cand.some((n) => /申込/.test(n.textContent || ''));
  });
}

/* 時間帯抽出（09:00～11:00 → 09:00-11:00） */
function pickTimeRange(text) {
  const s = text.replace(/[～〜~]/g, '-');
  const m = s.match(/([01]\d|2[0-3]):\d{2}-([01]\d|2[0-3]):\d{2}/);
  return m ? m[0] : '';
}

/* キャッシュ */
function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))); }
  catch { return new Set(); }
}
function saveCache(set) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify([...set], null, 2));
}
function keyOf(city, facility, date, time, court = '') {
  return [city, facility, date, time, court].join('|');
}

/* ターゲットの読み込み */
function loadTargets() {
  const raw = fs.readFileSync(TARGETS_PATH, 'utf8');
  return JSON.parse(raw);
}

/* メール送信（Gmail/SMTP） */
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,         // smtp.gmail.com
  port: Number(process.env.MAIL_PORT), // 465
  secure: true,
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});
async function sendMail(subject, text) {
  const info = await transporter.sendMail({
    from: `"施設予約Bot" <${process.env.MAIL_USER}>`,
    to: process.env.MAIL_TO,
    subject,
    text,
  });
  console.log('📬 Mail sent:', info.messageId);
}

/* 画面のリンク一覧をログ（デバッグ用） */
async function logLinkSnapshot(page, label) {
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a'))
      .map(a => (a.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  );
  console.log(`[DEBUG] after "${label}" ->`, labels.slice(0, 200).join(' | '));
}

/* 自治体ページに入る（直URL → 失敗時は画面操作） */
async function gotoMunicipality(page, muniName) {
  // 1) まずポータルへ
  await page.goto('https://yoyaku.e-kanagawa.lg.jp/portal/web/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanWait();

  // 2) 直URLマップ（安定）
  const muniMap = {
    '神奈川県': 'https://yoyaku.e-kanagawa.lg.jp/Kanagawa/Web/Wg_ModeSelect.aspx',
    '海老名市': 'https://yoyaku.e-kanagawa.lg.jp/Ebina/Web/Wg_ModeSelect.aspx',
    // 必要に応じて追加
  };
  if (muniMap[muniName]) {
    await page.goto(muniMap[muniName], { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await humanWait();
    return true;
  }

  // 3) 直URLがなければ、画面操作で遷移（表記ゆれに強い順）
  await clickLinkByText(page, '施設予約システムメニュー'); await humanWait();
  await clickLinkByText(page, 'ポータルサイトへ');         await humanWait();
  await clickLinkByText(page, '自治体から選ぶ');           await humanWait();

  const ok = await clickLinkByText(page, muniName);
  await humanWait();
  return ok;
}

/* ========= メイン ========= */
async function main() {
  const cfg = loadTargets(); // data/targets.json
  const cache = loadCache();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--lang=ja-JP',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });
  const page = await browser.newPage();
  await page.emulateTimezone('Asia/Tokyo');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });

  console.log(`実行時刻（JST）: ${dayjs().format('YYYY/MM/DD HH:mm:ss')}`);

  for (const city of cfg.cities) {
    console.log(`[INFO] 自治体へ遷移: ${city.name}`);
    const okCity = await gotoMunicipality(page, city.name);
    if (!okCity) {
      console.warn(`× 自治体へ入れませんでした: ${city.name}`);
      continue;
    }

    // デバッグ：リンクスナップショット
    await logLinkSnapshot(page, `${city.name} ModeSelect`);

    for (const t of city.facilities) {
      console.log(`[INFO] 施設探索: ${city.name} / ${t.name}`);

      // 施設検索（テキストボックスがあれば使う）
      const inputs = await page.$$('input[type="text"]');
      if (inputs.length > 0) {
        try {
          await inputs[0].click({ clickCount: 3 });
          await inputs[0].type(t.name, { delay: 15 });
          await clickSearchButton(page);
          await humanWait();
        } catch {}
      }

      // 施設リンクへ。見つからなければトークン分割で再トライ
      let moved = await clickLinkByText(page, t.name);
      if (!moved) {
        const tokens = t.name.split(/\s+/).filter(Boolean);
        for (const tok of tokens) {
          moved = await clickLinkByText(page, tok);
          if (moved) break;
        }
      }
      if (!moved) {
        console.warn(`× 施設見つからず: ${t.name}`);
        continue;
      }

      // 日付を回して空きチェック
      let d = dayjs(t.date_range.from);
      const end = dayjs(t.date_range.to);

      while (d.isBefore(end) || d.isSame(end, 'day')) {
        const label = d.format('YYYY/MM/DD');

        // カレンダー（aria-label）で選択
        let selected = false;
        const dayBtn = await page.$(`[aria-label="${label}"]`);
        if (dayBtn) {
          await dayBtn.click().catch(()=>{});
          await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(()=>{});
          selected = true;
        } else {
          // 「次/翌」ボタンでめくるフォールバック
          const clickedNext = await page.evaluate(() => {
            const cand = Array.from(document.querySelectorAll('button, a'));
            const n = cand.find((el) => /次|翌|Next/i.test(el.textContent || ''));
            if (n) { n.click(); return true; }
            return false;
          });
          if (clickedNext) {
            await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(()=>{});
            // 同じ日付で再試行
            continue;
          }
        }

        // テーブル走査
        const rows = await page.$$('table tr');
        let hitToday = 0;

        for (const row of rows) {
          const text = (await row.evaluate((el) => el.innerText)).replace(/\s+/g, ' ');
          const timeNorm = pickTimeRange(text);
          if (!timeNorm) continue;

          if (Array.isArray(t.times) && t.times.length > 0 && !t.times.includes(timeNorm)) continue;

          const hasApply = await rowHasApply(row);
          const openText = /空き|○|◯|予約可/.test(text);
          if (!(hasApply || openText)) continue;

          const court = (text.match(/コート[Ａ-ＺA-Z0-9]+|面\s*[A-ZＡ-Ｚ]/) || [])[0] || '';
          if (Array.isArray(t.courts) && t.courts.length > 0) {
            const ok = t.courts.some((c) => court.includes(c));
            if (!ok) continue;
          }

          const k = keyOf(city.name, t.name, d.format('YYYY-MM-DD'), timeNorm, court);
          if (!cache.has(k)) {
            cache.add(k);
            saveCache(cache);

            const body = [
              '🟢 空き枠を検知しました',
              `市: ${city.name}`,
              `施設: ${t.name}${court ? `（${court}）` : ''}`,
              `日付: ${d.format('YYYY-MM-DD (ddd)')}`,
              `時間: ${timeNorm}`,
              `URL: ${page.url()}`,
              '',
              '※予約は手動でお願いします。'
            ].join('\n');

            await sendMail(
              `【空き検知】${city.name} / ${t.name} / ${d.format('MM/DD')} ${timeNorm}`,
              body
            );
            console.log('🔔 Detect & Mail:', k);
            hitToday++;
          }
        }

        if (hitToday === 0) {
          console.log(`— ヒットなし: ${t.name} @ ${d.format('YYYY-MM-DD')}`);
        }

        d = d.add(1, 'day');
        await humanWait(300, 900);
      }

      // 施設ごとに軽く待機
      await humanWait(500, 1200);
      // 自治体トップへ戻す（画面差異で壊れにくくする）
      await gotoMunicipality(page, city.name);
    }
  }

  await browser.close();
  console.log(`完了: ${nowJST()}`);
}

/* ========= 実行 ========= */
main().catch(async (e) => {
  console.error('❌ watcher error:', e);
  try { await sendMail('【監視エラー】soccer-ground-checker', `${e.stack || e}`); } catch {}
  process.exit(1);
});
