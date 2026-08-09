import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import { chromium } from 'playwright';
import 'dotenv/config';
import fs from 'fs';

// ユーティリティ: 指定ミリ秒待機
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// プロフィールファイルの読み込み
function getProfileData() {
  const profilePath = './profile';
  if (fs.existsSync(profilePath)) {
    return fs.readFileSync(profilePath, 'utf-8');
  }
  return '';
}

// 1. 楽天APIから商品情報とアフィリエイトリンクを取得
async function fetchRakutenItem(keyword) {
  const appId = process.env.RAKUTEN_APPLICATION_ID;
  const affId = process.env.RAKUTEN_AFFILIATE_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;

  if (!appId || !accessKey) {
    throw new Error('RAKUTEN_APPLICATION_ID または RAKUTEN_ACCESS_KEY が設定されていません。');
  }

  let url = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?format=json&keyword=${encodeURIComponent(keyword)}&hits=15&applicationId=${appId}&accessKey=${accessKey}`;
  if (affId) {
    url += `&affiliateId=${affId}`;
  }

  let data = null;
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (json && json.Items && json.Items.length > 0) {
      data = json;
    } else if (json && json.error) {
      console.log(`[Rakuten API] エラー:`, json.error_description || json.error);
    }
  } catch (e) {
    console.log(`[通信エラー]:`, e.message);
  }

  if (!data || !data.Items || data.Items.length === 0) return null;

  // ランダムに1件選択
  const randomIndex = Math.floor(Math.random() * data.Items.length);
  const item = data.Items[randomIndex].Item;
  return {
    itemName: item.itemName,
    itemUrl: item.affiliateUrl || item.itemUrl,
    imageUrl: item.mediumImageUrls?.[0]?.imageUrl || item.mediumImageUrls?.[0] || '',
    price: item.itemPrice
  };
}

// 2. AIで記事本文・タイトル・ハッシュタグを生成（Gemini -> Groq -> フォールバック）
async function generateArticle(itemInfo) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;
  const profileContent = getProfileData();

  const prompt = `
以下の【プロフィール設定】と【商品情報】を基に、Amebaブログ用のオリジナル記事を作成してください。

【プロフィール設定】:
${profileContent}

【商品情報】:
- 商品名: ${itemInfo.itemName}
- 価格: ${itemInfo.price}円

【執筆ルール】:
1. 記事構成:
   - ① 「これ欲しいんだけど……」等の自己悩みから始める（例：「家で晩酌したいけど、煙や手入れが気になって……」）
   - ② 検討する選択肢や比較ポイント（価格・サイズ・火力・煙・掃除・収納等）を自然に提示
   - ③ 実際の生活シーン別（一人飲み、家族利用、掃除重視、火力重視など）の比較・解説
   - ④ 結論（「私ならこれを選びます」「こんな人におすすめです」）
   - ⑤ 楽天への案内文言（「現在の価格やポイントはこちらで確認できます」）
2. 口調: 気取らない・ちょっと大人・居酒屋っぽい、「〜なんですよね」「〜かなと思います」の自然な会話調。
3. タイトル: 「〜はどう？」「〜って本当に家で使える？」「〜どっちがいい？」のような検索表示向けで惹きつける35文字以内のタイトル。

以下のJSON形式のみで出力してください（Markdownコードブロック表記不可）：
{
  "title": "記事タイトル",
  "contentHtml": "<p>本文HTML...</p>",
  "tags": ["おうち宴会", "卓上家電", "晩酌グッズ", "楽天"]
}
`;

  // --- A. Gemini API 試行 ---
  if (geminiApiKey) {
    const models = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'];
    const genAI = new GoogleGenerativeAI(geminiApiKey);

    for (const modelName of models) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const response = await model.generateContent(prompt);
        const text = response.response.text().trim();
        const cleanedJson = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        const article = JSON.parse(cleanedJson);
        console.log(`[AI生成] Gemini (${modelName}) で記事生成に成功しました。`);
        return article;
      } catch (err) {
        console.log(`[Gemini API (${modelName}) エラー]: ${err.message}`);
      }
    }
  } else {
    console.log('[Gemini API] GEMINI_API_KEY が設定されていません。');
  }

  // --- B. Groq API 試行 ---
  if (groqApiKey) {
    console.log('[AI生成] Gemini不可のため Groq API（llama-3.3-70b-versatile）を試行します...');
    try {
      const groq = new Groq({ apiKey: groqApiKey });
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: 'あなたはAmebaブログの人気ブロガーです。必ず要求されたJSON形式のみで回答してください。' },
          { role: 'user', content: prompt }
        ],
        model: 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' }
      });
      const text = chatCompletion.choices[0]?.message?.content || '';
      const article = JSON.parse(text);
      console.log(`[AI生成] Groq (llama-3.3-70b-versatile) で記事生成に成功しました！`);
      return article;
    } catch (err) {
      console.log(`[Groq API エラー]: ${err.message}`);
    }
  } else {
    console.log('[Groq API] GROQ_API_KEY が設定されていません。');
  }

  // --- C. フォールバック記事生成 ---
  console.log('すべてのAI APIが利用できないため、profile設定に基づいたオリジナル記事生成にフォールバックします。');
  
  const nameSnippet = itemInfo.itemName.replace(/【.*?】|\[.*?\]/g, '').trim().slice(0, 24);
  const titles = [
    `【本音比較】${nameSnippet}って実際どう？一人飲みに使える？`,
    `家で晩酌するなら${nameSnippet}は買い？試す価値を検証`,
    `煙や手入れは？${nameSnippet}を卓上家電好きがチェックしてみた`
  ];
  const selectedTitle = titles[Math.floor(Math.random() * titles.length)];

  const introWorries = [
    `家でゆっくり晩酌を楽しむ時間って最高ですよね。でも、「家で本格的に調理しながら飲みたいけれど、煙や後片付けが大変そう……」と悩んだことはありませんか？`,
    `「もっとおうち居酒屋感をアップさせたい！」と思いつつ、どの卓上家電を選ぶべきか迷ってしまうことってありますよね。`
  ];
  const selectedIntro = introWorries[Math.floor(Math.random() * introWorries.length)];

  const contentHtml = `
<p>${selectedIntro}</p>

<p>今回注目したのが、こちらの「<strong>${itemInfo.itemName}</strong>」なんですよね。</p>

<h2>💡 気になる比較ポイントと実際の使用感</h2>
<p>卓上家電を選ぶときに重視したいのは、やっぱり以下のポイントかなと思います。</p>
<ul>
  <li><strong>サイズ感・収納性:</strong> テーブルの上で邪魔にならず、片付けがラクか</li>
  <li><strong>火力・使い勝手:</strong> お酒を飲みながらちょうどいいペースで調理できるか</li>
  <li><strong>お手入れのしやすさ:</strong> 油汚れやプレートの洗やすさ</li>
</ul>

<h2>🍶 どんな人・どんなシーンにおすすめ？</h2>
<p>実際に使う生活シーンに合わせて考えると、以下のような選び方がしっくりきます。</p>
<ul>
  <li><strong>一人飲み・サクッと晩酌したい方:</strong> コンパクトで準備が簡単なタイプが最適です。</li>
  <li><strong>家族や友人とおうち宴会を楽しみたい方:</strong> 火力や容量に余裕があるタイプが重宝します。</li>
</ul>

<h2>📝 まとめ・結論</h2>
<p>「おうちでの料理や晩酌をちょっと楽しくしたい！」という方には、間違いなく気分を盛り上げてくれる一台かなと思います。</p>

<p>現在の価格や還元ポイント、最新の在庫状況はこちらから確認できますので、気になる方はチェックしてみてくださいね。</p>
`;

  return {
    title: selectedTitle,
    contentHtml: contentHtml,
    tags: ["おうち宴会", "卓上家電", "晩酌グッズ", "楽天おすすめ"]
  };
}

// 3. PlaywrightによるAmeba自動投稿処理
async function postToAmeba(title, contentHtml, tags, itemInfo) {
  const amebaId = process.env.AMEBA_ID;
  const amebaPassword = process.env.AMEBA_PASSWORD;
  const amebaCookieJson = process.env.AMEBA_COOKIES;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  };

  const context = await browser.newContext(contextOptions);

  // CookieがSecretに登録されている場合はセット
  if (amebaCookieJson) {
    try {
      const cookies = JSON.parse(amebaCookieJson);
      await context.addCookies(cookies);
      console.log('保存された認証Cookie（セッション）を適用しました。');
    } catch (e) {
      console.log('AMEBA_COOKIESの読み込みに失敗しました:', e.message);
    }
  }

  const page = await context.newPage();

  try {
    console.log('ブログエディタ画面へアクセス中...');
    await page.goto('https://blog.ameba.jp/ucs/entry/srventryinsertinput.do', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // ログイン画面にリダイレクトされたか判定
    if (page.url().includes('auth.user.ameba.jp') || page.url().includes('/signin') || page.url().includes('/login')) {
      console.log('ログインセッションが無効です。ID/パスワードによるログインを試みます...');
      if (!amebaId || !amebaPassword) {
        throw new Error('AMEBA_ID または AMEBA_PASSWORD が設定されていません。またCookieセッションも無効です。');
      }

      await page.goto('https://dauth.user.ameba.jp/login/ameba', { waitUntil: 'domcontentloaded' });
      console.log(`アカウントID「${amebaId.slice(0, 3)}***」でログイン情報を入力中...`);

      const fillFormInput = async (selector, value) => {
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 15000 });
        await locator.click();
        await locator.focus();
        await locator.fill(value);
        await locator.evaluate((el, val) => {
          const tracker = el._valueTracker;
          if (tracker) tracker.setValue(val);
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }, value);
        await page.waitForTimeout(300);
      };

      await fillFormInput('input[name="accountId"], #accountId', amebaId);
      await fillFormInput('input[name="password"], #password', amebaPassword);

      console.log('ログインボタンを押下中...');
      const submitBtn = page.locator('button.js-submit-button, button[type="submit"], input[type="submit"]').first();
      await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
      await submitBtn.click();
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(5000);

      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(1000);
        const curUrl = page.url();
        if (!curUrl.includes('/signin') && !curUrl.includes('/login') && curUrl.includes('ameba.jp')) {
          break;
        }
      }

      if (page.url().includes('auth.user.ameba.jp') || page.url().includes('/signin')) {
        const pageErrors = await page.locator('[class*="error"], [class*="Error"], .c-errorMessage, #error-msg, p').allInnerTexts().catch(() => []);
        const realErrors = pageErrors.filter(t => t && typeof t === 'string' && !t.includes('Twitter') && !t.includes('Facebook') && !t.includes('Google') && !t.includes('お困りの方') && (t.includes('正しくあり') || t.includes('一致し') || t.includes('違います') || t.includes('入力してください') || t.includes('失敗')));
        const errorMsg = realErrors.join(' | ');
        console.error('ログイン画面検出エラー:', errorMsg || '認証未完了（パスワード不一致またはGoogleログイン専用アカウントの可能性があります）');
        throw new Error(`Amebaログイン認証に失敗しました。Googleログイン専用アカウントの場合はCookie（AMEBA_COOKIES）をSecretに設定してください。`);
      }

      // ログイン成功したら再度エディタ画面へ
      await page.goto('https://blog.ameba.jp/ucs/entry/srventryinsertinput.do', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }

    console.log('エディタ画面URL:', page.url());
    console.log('エディタ画面タイトル:', await page.title());

    console.log('記事タイトルを入力中...');
    const titleInput = page.locator('input[name="entry_title"], #entryTitle, textarea[data-testid="entry-title-input"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 30000 });
    await titleInput.fill(title);

    const metaTitleInput = page.locator('input[name="meta_title"]');
    if (await metaTitleInput.isVisible().catch(() => false)) {
      await metaTitleInput.fill(title).catch(() => {});
    }

    // 楽天アフィリエイトカード（画像＋リンク）の生成
    const rakutenHtml = `
      <div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin: 20px 0; background-color: #fafafa; display: flex; align-items: center; gap: 16px;">
        ${itemInfo.imageUrl ? `<a href="${itemInfo.itemUrl}" target="_blank" rel="nofollow noopener"><img src="${itemInfo.imageUrl}" alt="${title}" style="max-width: 120px; height: auto; border-radius: 4px;" /></a>` : ''}
        <div>
          <h4 style="margin: 0 0 8px 0; font-size: 16px;"><a href="${itemInfo.itemUrl}" target="_blank" rel="nofollow noopener" style="color: #333; text-decoration: none;">${itemInfo.itemName}</a></h4>
          <p style="margin: 0 0 8px 0; color: #bf0000; font-weight: bold;">価格: ${itemInfo.price.toLocaleString()}円 (税込)</p>
          <a href="${itemInfo.itemUrl}" target="_blank" rel="nofollow noopener" style="display: inline-block; background-color: #bf0000; color: #fff; padding: 8px 16px; border-radius: 4px; text-decoration: none; font-size: 14px; font-weight: bold;">楽天市場で詳細を見る</a>
        </div>
      </div>
    `;

    const fullHtml = contentHtml + rakutenHtml;

    console.log('HTML表示モードに切り替え中...');
    const sourceBtn = page.locator('button#js-editorModeButton--source, button:has-text("HTML表示")').first();
    if (await sourceBtn.isVisible().catch(() => false)) {
      await sourceBtn.click();
      await page.waitForTimeout(1000);
    }

    console.log('本文HTMLを入力中...');
    const editor = page.locator('textarea#amebloeditor, textarea[name="entry_text"], #entryText').first();
    await editor.evaluate((el, html) => {
      el.value = html;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, fullHtml);

    console.log('ハッシュタグ入力中...');
    for (const tag of tags) {
      const tagInput = page.locator('input[placeholder*="ハッシュタグ"], input[data-testid="hashtag-input"], #js-hashtag-button').first();
      if (await tagInput.isVisible().catch(() => false)) {
        await tagInput.fill(tag).catch(() => {});
        await tagInput.press('Enter').catch(() => {});
        await sleep(500);
      }
    }

    console.log('モーダルダイアログをクローズ中...');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    // 【安全対策】投稿ボタン押下直前に 1分〜5分（60〜300秒）のランダム待機を挿入
    if (process.env.SKIP_DELAY === 'true') {
      console.log('SKIP_DELAY が有効なため、投稿前待機をスキップします。');
    } else {
      const delaySec = Math.floor(Math.random() * 240) + 60; // 60秒(1分)〜300秒(5分)
      console.log(`安全運用対策: BAN・bot検知防止のため、投稿ボタン押下前に ${delaySec} 秒間（約${Math.round(delaySec/60)}分）ランダム待機します...`);
      await sleep(delaySec * 1000);
    }

    console.log('「投稿する」ボタンを押下中...');
    const postBtn = page.locator('button.js-submitButton:has-text("投稿する"), button:has-text("投稿する"), [data-testid="entry-submit-button"]').first();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    
    // スクロールして画面に確実に表示させてからクリック
    await postBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);

    // 投稿完了画面への遷移（`entryend.do` や URLの変化）を監視
    const navigationPromise = page.waitForNavigation({ timeout: 30000 }).catch(() => null);
    
    await postBtn.click({ force: true }).catch(async () => {
      await postBtn.evaluate(el => el.click());
    });

    await navigationPromise;
    await page.waitForTimeout(3000);

    const endUrl = page.url();
    console.log('投稿押下後の最終URL:', endUrl);

    if (endUrl.includes('entryend') || endUrl.includes('complete') || !endUrl.includes('srventryinsertinput.do')) {
      console.log('【投稿成功】記事の投稿完了画面への遷移を確認しました！');
    } else {
      // エラーメッセージ等の検出
      const errorMsg = await page.locator('.c-errorMessage, [class*="error"], .error-message').allInnerTexts().catch(() => []);
      if (errorMsg.length > 0) {
        console.error('【投稿失敗検出】画面エラーメッセージ:', errorMsg.join(' | '));
      } else {
        console.warn('【注意】投稿画面からの遷移が検出されませんでした。保存状態をご確認ください。');
      }
    }

  } catch (error) {
    console.error('投稿処理エラー:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// メイン処理
async function main() {
  const keywords = [
    '卓上焼き鳥器',
    '卓上焼肉グリル 無煙',
    'ホットサンドメーカー 卓上',
    '電気せいろ',
    '電気酒燗器',
    '卓上保温プレート',
    '多機能 電気鍋 卓上',
    'たこ焼き器 卓上',
    '卓上 焼き魚グリル',
    'スープメーカー 電気'
  ];
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
