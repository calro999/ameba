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

  // --- A. Gemini API 試行（現行3.x系モデル） ---
  if (geminiApiKey) {
    const models = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];
    const genAI = new GoogleGenerativeAI(geminiApiKey);

    for (const modelName of models) {
      try {
        console.log(`[Gemini API] モデル ${modelName} を試行中...`);
        const model = genAI.getGenerativeModel({ model: modelName });
        const response = await model.generateContent(prompt);
        const text = response.response.text().trim();
        const cleanedJson = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        const article = JSON.parse(cleanedJson);
        console.log(`[AI生成] Gemini (${modelName}) で記事生成に成功！`);
        return article;
      } catch (err) {
        console.log(`[Gemini API (${modelName}) エラー]: ${err.message}`);
      }
    }
    console.log('[Gemini API] 全モデルで失敗しました。');
  } else {
    console.log('[Gemini API] GEMINI_API_KEY が設定されていないため、スキップします。');
  }

  // --- B. Groq API 試行（複数モデルフォールバック） ---
  if (groqApiKey) {
    const groqModels = [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B (instant)' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' }
    ];
    const groq = new Groq({ apiKey: groqApiKey });

    for (const m of groqModels) {
      try {
        console.log(`[Groq API] モデル ${m.name} (${m.id}) を試行中...`);
        const chatCompletion = await groq.chat.completions.create({
          messages: [
            { role: 'system', content: 'あなたはAmebaブログの人気ブロガーです。必ず要求されたJSON形式のみで回答してください。' },
            { role: 'user', content: prompt }
          ],
          model: m.id,
          response_format: { type: 'json_object' }
        });
        const text = chatCompletion.choices[0]?.message?.content || '';
        const article = JSON.parse(text);
        console.log(`[AI生成] Groq (${m.name}) で記事生成に成功！`);
        return article;
      } catch (err) {
        console.log(`[Groq API (${m.name}) エラー]: ${err.message}`);
      }
    }
    console.log('[Groq API] 全モデルで失敗しました。');
  } else {
    console.log('[Groq API] GROQ_API_KEY が設定されていないため、スキップします。');
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

// エディタ本文にHTMLを注入する関数
// CKEditorの内部データモデルに直接setData()することが最重要。
// iframe.body.innerHTMLを変更してもCKEditorは認識しない（フォーム送信時に空になる）。
async function injectEditorContent(page, fullHtml) {

  // --- 方式1（最優先）: CKEditorインスタンスに直接setData() ---
  console.log('[エディタ] 方式1: CKEditor.setData() を試行中...');
  const ckeResult = await page.evaluate((html) => {
    if (typeof CKEDITOR !== 'undefined' && CKEDITOR.instances) {
      const names = Object.keys(CKEDITOR.instances);
      if (names.length > 0) {
        for (const name of names) {
          const inst = CKEDITOR.instances[name];
          inst.setData(html);
          // フォームのhidden textareaにも同期
          if (typeof inst.updateElement === 'function') {
            inst.updateElement();
          }
        }
        return { success: true, instances: names };
      }
    }
    return { success: false, instances: [] };
  }, fullHtml).catch(() => ({ success: false, instances: [] }));

  if (ckeResult.success) {
    console.log(`[エディタ] 方式1成功: CKEditor.setData() でインスタンス [${ckeResult.instances.join(', ')}] にデータ注入完了`);
    await page.waitForTimeout(1000);
    return true;
  }
  console.log('[エディタ] CKEditorインスタンスが見つかりません。他の方式を試行します。');

  // --- 方式2: HTML表示モード（ソースモード）のtextarea ---
  console.log('[エディタ] 方式2: HTML表示モード（textarea）を試行中...');
  const sourceBtn = page.locator('button#js-editorModeButton--source, button:has-text("HTML表示"), button:has-text("HTML編集"), [data-testid="source-mode-button"]').first();
  const sourceBtnVisible = await sourceBtn.isVisible().catch(() => false);
  if (sourceBtnVisible) {
    await sourceBtn.click();
    await page.waitForTimeout(2000);
    console.log('[エディタ] HTML表示ボタンをクリックしました。');
  }

  const textareaSelectors = [
    'textarea.cke_source',
    'textarea#amebloeditor',
    'textarea[name="entry_text"]',
    '#entryText',
    'textarea[class*="source"]'
  ];
  for (const sel of textareaSelectors) {
    const textarea = page.locator(sel).first();
    const visible = await textarea.isVisible().catch(() => false);
    if (visible) {
      console.log(`[エディタ] textarea検出: ${sel}`);
      await textarea.click();
      await textarea.fill(fullHtml);
      await page.waitForTimeout(500);
      const val = await textarea.inputValue().catch(() => '');
      if (val.length > 10) {
        console.log(`[エディタ] 方式2成功: textarea(${sel})に ${val.length} 文字入力完了`);
        return true;
      }
    }
  }

  // 通常モードに戻す
  if (sourceBtnVisible) {
    const normalBtn = page.locator('button:has-text("通常表示"), button:has-text("通常編集"), button#js-editorModeButton--normal').first();
    if (await normalBtn.isVisible().catch(() => false)) {
      await normalBtn.click();
      await page.waitForTimeout(2000);
    }
  }

  // --- 方式3: iframe内contenteditable + CKEditor同期 ---
  console.log('[エディタ] 方式3: iframe + contenteditable + CKEditor同期 を試行中...');
  const iframeSelectors = [
    'iframe.cke_wysiwyg_frame',
    '#cke_1_contents iframe',
    '.cke_contents iframe',
    'iframe[class*="editor"]'
  ];

  for (const iframeSel of iframeSelectors) {
    try {
      const iframeEl = page.locator(iframeSel).first();
      if (await iframeEl.isVisible().catch(() => false)) {
        console.log(`[エディタ] iframe検出: ${iframeSel}`);
        const frame = page.frameLocator(iframeSel).first();
        const body = frame.locator('body[contenteditable="true"], body.cke_editable, body');
        if (await body.first().isVisible({ timeout: 5000 }).catch(() => false)) {
          await body.first().evaluate((el, html) => {
            el.innerHTML = html;
          }, fullHtml);
          await page.waitForTimeout(500);

          // iframeにHTML注入した後、CKEditorの内部データモデルも同期
          const synced = await page.evaluate((html) => {
            if (typeof CKEDITOR !== 'undefined' && CKEDITOR.instances) {
              for (const name in CKEDITOR.instances) {
                CKEDITOR.instances[name].setData(html);
                if (typeof CKEDITOR.instances[name].updateElement === 'function') {
                  CKEDITOR.instances[name].updateElement();
                }
              }
              return true;
            }
            // CKEditorが無い場合、隠しtextareaに直接書き込む
            const ta = document.querySelector('textarea[name="entry_text"]');
            if (ta) {
              ta.value = html;
              ta.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            return false;
          }, fullHtml).catch(() => false);

          const len = await body.first().evaluate(el => el.innerHTML.length).catch(() => 0);
          console.log(`[エディタ] 方式3: iframe注入 ${len} 文字, CKEditor同期: ${synced ? '成功' : '失敗'}`);
          if (len > 10) {
            return true;
          }
        }
      }
    } catch (e) {
      console.log(`[エディタ] iframe(${iframeSel})へのアクセス失敗: ${e.message}`);
    }
  }

  // --- 方式4: hidden textarea直接書き込み ---
  console.log('[エディタ] 方式4: hidden textarea直接書き込みを試行中...');
  const injected = await page.evaluate((html) => {
    let success = false;
    const targets = document.querySelectorAll('textarea[name="entry_text"], #entryText, #entry_text');
    targets.forEach(el => {
      el.value = html;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      success = true;
    });
    return success;
  }, fullHtml).catch(() => false);

  if (injected) {
    console.log('[エディタ] 方式4成功: hidden textarea に直接書き込みました。');
    return true;
  }

  // デバッグ: エディタDOM構造をダンプ
  console.error('[エディタ] 全方式失敗。エディタDOM構造をダンプします...');
  const debugInfo = await page.evaluate(() => {
    const iframes = [...document.querySelectorAll('iframe')].map(f => ({ tag: 'iframe', id: f.id, class: f.className, src: f.src, title: f.title }));
    const textareas = [...document.querySelectorAll('textarea')].map(t => ({ tag: 'textarea', id: t.id, name: t.name, class: t.className, visible: t.offsetParent !== null }));
    const editables = [...document.querySelectorAll('[contenteditable]')].map(e => ({ tag: e.tagName, id: e.id, class: e.className, role: e.getAttribute('role') }));
    const hasCKE = typeof CKEDITOR !== 'undefined';
    return { iframes, textareas, editables, hasCKEditor: hasCKE };
  }).catch(() => ({}));
  console.error('[エディタ] DOM構造:', JSON.stringify(debugInfo, null, 2));
  return false;
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
    await page.waitForTimeout(5000);

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
        throw new Error('Amebaログイン認証に失敗しました。Googleログイン専用アカウントの場合はCookie（AMEBA_COOKIES）をSecretに設定してください。');
      }

      await page.goto('https://blog.ameba.jp/ucs/entry/srventryinsertinput.do', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
    }

    console.log('エディタ画面URL:', page.url());
    console.log('エディタ画面タイトル:', await page.title());

    // --- タイトル入力 ---
    console.log('記事タイトルを入力中...');
    const titleInput = page.locator('input[name="entry_title"], #entryTitle, textarea[data-testid="entry-title-input"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 30000 });
    await titleInput.fill(title);
    console.log(`タイトル「${title}」を入力しました。`);

    // --- 楽天アフィリエイトカード生成 ---
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

    // --- 本文HTML入力（複数方式試行） ---
    console.log('本文HTMLを入力中...');
    const editorSuccess = await injectEditorContent(page, fullHtml);
    if (!editorSuccess) {
      throw new Error('エディタへの本文入力に全方式で失敗しました。Amebaのエディタ仕様が変更された可能性があります。');
    }

    // --- ハッシュタグ入力 ---
    console.log('ハッシュタグ入力中...');
    for (const tag of tags) {
      const tagInput = page.locator('input[placeholder*="ハッシュタグ"], input[data-testid="hashtag-input"], #js-hashtag-button').first();
      if (await tagInput.isVisible().catch(() => false)) {
        await tagInput.fill(tag).catch(() => {});
        await tagInput.press('Enter').catch(() => {});
        await sleep(500);
      }
    }

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    // --- 安全対策: 投稿ボタン押下前に1〜5分の待機 ---
    if (process.env.SKIP_DELAY === 'true') {
      console.log('SKIP_DELAY が有効なため、投稿前待機をスキップします。');
    } else {
      const delaySec = Math.floor(Math.random() * 240) + 60;
      console.log(`安全運用対策: 投稿ボタン押下前に ${delaySec} 秒間（約${Math.round(delaySec/60)}分）ランダム待機します...`);
      await sleep(delaySec * 1000);
    }

    // --- 投稿前にCKEditorデータをフォームに同期 ---
    console.log('CKEditorデータをフォームに同期中...');
    const syncResult = await page.evaluate(() => {
      const result = { ckeSync: false, textareaLen: 0 };
      if (typeof CKEDITOR !== 'undefined' && CKEDITOR.instances) {
        for (const name in CKEDITOR.instances) {
          CKEDITOR.instances[name].updateElement();
          result.ckeSync = true;
        }
      }
      const ta = document.querySelector('textarea[name="entry_text"]');
      if (ta) result.textareaLen = ta.value.length;
      return result;
    }).catch(() => ({ ckeSync: false, textareaLen: 0 }));
    console.log(`CKEditor同期: ${syncResult.ckeSync}, hidden textarea長: ${syncResult.textareaLen} 文字`);

    if (syncResult.textareaLen < 10) {
      console.warn('hidden textareaが空です。直接書き込みます...');
      await page.evaluate((html) => {
        const ta = document.querySelector('textarea[name="entry_text"]');
        if (ta) {
          ta.value = html;
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, fullHtml).catch(() => {});
    }
    await page.waitForTimeout(500);

    // --- 投稿ボタンの情報をデバッグ出力 ---
    const btnDebug = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, input[type="submit"]')];
      return btns.filter(b => b.textContent?.includes('投稿') || b.value?.includes('投稿') || b.className?.includes('submit'))
        .map(b => ({
          tag: b.tagName,
          type: b.type,
          text: b.textContent?.trim().slice(0, 30),
          class: b.className?.slice(0, 60),
          id: b.id,
          disabled: b.disabled,
          form: b.form ? b.form.id || b.form.action?.slice(-50) : null
        }));
    }).catch(() => []);
    console.log('投稿関連ボタン一覧:', JSON.stringify(btnDebug));

    // --- 投稿ボタン押下 ---
    console.log('「投稿する」ボタンを押下中...');
    const postBtn = page.locator('button.js-submitButton:has-text("投稿する"), button:has-text("投稿する"), input[type="submit"][value*="投稿"], [data-testid="entry-submit-button"]').first();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    await postBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);

    // クリックして画面遷移またはダイアログを待機
    const navigationPromise = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
    await postBtn.click().catch(async () => {
      console.log('通常クリック失敗。force clickを試行...');
      await postBtn.click({ force: true }).catch(() => {});
    });

    // 1秒待って確認ダイアログが出たかチェック
    await page.waitForTimeout(2000);
    console.log('ボタンクリック後のURL:', page.url());

    // 確認ダイアログ/モーダル/2段階目の「投稿する」ボタンを処理
    const confirmBtns = [
      'button:has-text("公開")',
      'button:has-text("OK")',
      'button:has-text("はい")',
      'button:has-text("確認")',
      '.modal button:has-text("投稿")',
      '[class*="confirm"] button:has-text("投稿")',
      '[class*="dialog"] button:has-text("投稿")',
      '[class*="modal"] button',
      'button.js-publishButton'
    ];
    for (const confirmSel of confirmBtns) {
      const confirmBtn = page.locator(confirmSel).first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        console.log(`確認ダイアログ検出: ${confirmSel}`);
        await confirmBtn.click().catch(() => {});
        await page.waitForTimeout(2000);
        break;
      }
    }

    // ナビゲーション完了を待機
    await navigationPromise;
    await page.waitForTimeout(3000);

    let endUrl = page.url();
    console.log('最終URL:', endUrl);

    // まだ遷移してない場合: フォーム直接submit()を試行
    if (endUrl.includes('srventryinsertinput.do')) {
      console.log('まだ投稿画面です。フォーム直接submit()を試行します...');
      const formSubmitted = await page.evaluate(() => {
        // CKEditor最終同期
        if (typeof CKEDITOR !== 'undefined' && CKEDITOR.instances) {
          for (const name in CKEDITOR.instances) {
            CKEDITOR.instances[name].updateElement();
          }
        }
        // フォーム検索
        const forms = document.querySelectorAll('form');
        for (const form of forms) {
          const action = form.action || '';
          if (action.includes('entry') || form.querySelector('textarea[name="entry_text"]') || form.querySelector('input[name="entry_title"]')) {
            // publish_flgをセット（Amebaは公開=1）
            let publishInput = form.querySelector('input[name="publish_flg"]');
            if (!publishInput) {
              publishInput = document.createElement('input');
              publishInput.type = 'hidden';
              publishInput.name = 'publish_flg';
              form.appendChild(publishInput);
            }
            publishInput.value = '1';
            form.submit();
            return { submitted: true, action: action.slice(-60) };
          }
        }
        return { submitted: false, formCount: forms.length };
      }).catch(() => ({ submitted: false }));
      console.log('フォーム直接submit結果:', JSON.stringify(formSubmitted));

      if (formSubmitted.submitted) {
        await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        endUrl = page.url();
        console.log('フォームsubmit後のURL:', endUrl);
      }
    }

    if (endUrl.includes('entryend') || endUrl.includes('complete') || !endUrl.includes('srventryinsertinput.do')) {
      console.log('【投稿成功】記事の投稿完了画面への遷移を確認しました！');
    } else {
      // デバッグ: ページの状態をダンプ
      const pageDebug = await page.evaluate(() => {
        const body = document.body?.innerText?.slice(0, 1000) || '';
        const title = document.title;
        const forms = [...document.querySelectorAll('form')].map(f => ({
          id: f.id, action: f.action?.slice(-60), method: f.method,
          fields: [...f.elements].slice(0, 15).map(e => ({ name: e.name, type: e.type, valueLen: e.value?.length || 0 }))
        }));
        return { title, bodySnippet: body, forms };
      }).catch(() => ({}));
      console.error('【投稿失敗】ページ状態:', JSON.stringify(pageDebug, null, 2));
      throw new Error('投稿に失敗しました。上記のデバッグ情報を確認してください。');
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
