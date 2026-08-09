import { GoogleGenAI } from '@google/genai';
import { chromium } from 'playwright';
import 'dotenv/config';

// ユーティリティ: 指定ミリ秒待機
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. 楽天APIから商品情報とアフィリエイトリンクを取得 (OpenAPI対応)
async function fetchRakutenItem(keyword) {
  const appId = process.env.RAKUTEN_APPLICATION_ID;
  const affId = process.env.RAKUTEN_AFFILIATE_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;

  if (!appId || !affId || !accessKey) {
    throw new Error('RAKUTEN_APPLICATION_ID, RAKUTEN_AFFILIATE_ID または RAKUTEN_ACCESS_KEY が設定されていません。');
  }

  // OpenAPI エンドポイント
  const url = `https://openapi.rakuten.co.jp/services/api/IchibaItem/Search/20220601?format=json&keyword=${encodeURIComponent(keyword)}&hits=10&applicationId=${appId}&affiliateId=${affId}&accessKey=${accessKey}`;
  
  const res = await fetch(url);
  const data = await res.json();
  if (!data.Items || data.Items.length === 0) return null;

  // ランダムに1件選択
  const randomIndex = Math.floor(Math.random() * data.Items.length);
  const item = data.Items[randomIndex].Item;
  return {
    itemName: item.itemName,
    itemUrl: item.affiliateUrl || item.itemUrl,
    imageUrl: item.mediumImageUrls[0]?.imageUrl || '',
    price: item.itemPrice
  };
}

// 2. Gemini APIで記事本文・タイトル・ハッシュタグを生成
async function generateArticle(itemInfo) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY が設定されていません。');
  }

  const ai = new GoogleGenAI({ apiKey });
  
  const prompt = `
以下の商品を紹介するブログ記事をAmebaブログ用に作成してください。

商品名: ${itemInfo.itemName}
価格: ${itemInfo.price}円

以下のJSON形式のみで回答を出力してください（Markdownコードブロック表記は含めないでください）：
{
  "title": "検索表示用タイトル（SEOを意識した魅力的で自然なタイトル）",
  "contentHtml": "<p>読者の興味を惹く導入文...</p><h2>商品の魅力ポイント</h2><p>具体的な感想やメリット...</p>",
  "tags": ["おすすめ", "便利グッズ", "楽天"]
}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  const text = response.text.trim();
  const cleanedJson = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(cleanedJson);
}

// 3. PlaywrightによるAmeba自動投稿処理
async function postToAmeba(title, contentHtml, tags, itemInfo) {
  const amebaId = process.env.AMEBA_ID;
  const amebaPassword = process.env.AMEBA_PASSWORD;
  if (!amebaId || !amebaPassword) {
    throw new Error('AMEBA_ID または AMEBA_PASSWORD が設定されていません。');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    console.log('Amebaログイン画面にアクセス中...');
    await page.goto('https://www.ameba.jp/login', { waitUntil: 'domcontentloaded' });

    console.log('ログイン情報を入力中...');
    await page.fill('input[name="accountId"]', amebaId);
    await page.fill('input[name="password"]', amebaPassword);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      page.click('button[type="submit"], input[type="submit"], button:has-text("ログイン")')
    ]);

    console.log('ブログエディタ画面へ移動中...');
    await page.goto('https://blog.ameba.jp/ucs/entry/srventryinsertinput.do', { waitUntil: 'networkidle' });

    console.log('検索表示タイトルを入力中...');
    const titleInput = page.locator('textarea[data-testid="entry-title-input"], textarea[name="entry_title"], #entryTitle');
    await titleInput.waitFor({ state: 'visible', timeout: 10000 });
    await titleInput.fill(title);

    // 楽天アフィリエイトカード（画像＋リンク）の生成
    const rakutenHtml = `
<br>
<div style="border: 1px solid #e0e0e0; padding: 15px; margin: 15px 0; border-radius: 8px; background-color: #fafafa; text-align: center;">
  <a href="${itemInfo.itemUrl}" target="_blank" rel="noopener" style="text-decoration: none;">
    <img src="${itemInfo.imageUrl}" alt="${itemInfo.itemName}" style="max-width: 200px; height: auto; border-radius: 4px;" />
    <p style="margin-top: 10px; color: #333; font-weight: bold; font-size: 14px;">${itemInfo.itemName}</p>
    <p style="color: #bf0000; font-weight: bold; font-size: 16px;">価格: ${itemInfo.price.toLocaleString()}円</p>
    <span style="display: inline-block; padding: 8px 16px; background-color: #bf0000; color: #fff; border-radius: 4px; font-weight: bold; margin-top: 5px;">楽天で詳細を見る</span>
  </a>
</div>`;

    const fullHtml = contentHtml + rakutenHtml;

    console.log('HTML表示モードに切り替え中...');
    const htmlTab = page.locator('button:has-text("HTML表示"), [data-testid="html-editor-tab"], li:has-text("HTML表示")');
    if (await htmlTab.isVisible()) {
      await htmlTab.click();
    }

    console.log('本文HTMLを入力中...');
    const editor = page.locator('textarea[data-testid="html-editor-textarea"], #entryText, textarea[name="entry_text"]');
    await editor.waitFor({ state: 'visible', timeout: 10000 });
    await editor.fill(fullHtml);

    console.log('ハッシュタグ入力中...');
    for (const tag of tags) {
      const tagInput = page.locator('input[placeholder*="ハッシュタグ"], input[data-testid="hashtag-input"]');
      if (await tagInput.isVisible()) {
        await tagInput.fill(tag);
        await tagInput.press('Enter');
        await sleep(500);
      }
    }

    console.log('「投稿する」ボタンを押下中...');
    const submitBtn = page.locator('button:has-text("投稿する"), [data-testid="entry-submit-button"], button.js-submit-btn');
    await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await submitBtn.click();

    await page.waitForTimeout(5000);
    console.log('投稿完了！');

  } catch (error) {
    console.error('投稿処理エラー:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// メイン処理（ランダム遅延含む）
async function main() {
  // 安全運用：0分〜15分のランダム遅延を挿入
  const randomDelayMinutes = Math.floor(Math.random() * 15);
  console.log(`安全運用対策: 投稿前に ${randomDelayMinutes} 分間ランダム待機します...`);
  await sleep(randomDelayMinutes * 60 * 1000);

  const keywords = ['便利グッズ', '人気 スイーツ', 'ガジェット おすすめ', 'コスメ ランキング', 'キッチングッズ'];
  const randomKeyword = keywords[Math.floor(Math.random() * keywords.length)];

  console.log(`検索キーワード: 「${randomKeyword}」`);
  const itemInfo = await fetchRakutenItem(randomKeyword);

  if (!itemInfo) {
    console.log('対象商品が見つかりませんでした。スキップします。');
    return;
  }

  console.log(`商品「${itemInfo.itemName}」を取得しました。記事を生成します...`);
  const article = await generateArticle(itemInfo);

  console.log('Amebaへの投稿処理を開始します...');
  await postToAmeba(article.title, article.contentHtml, article.tags, itemInfo);
}

main();
