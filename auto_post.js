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
async function injectEditorContent(page, fullHtml) {
  console.log('[エディタ] 方式1: CKEditor.setData() を試行中...');
  const ckeResult = await page.evaluate((html) => {
    if (typeof CKEDITOR !== 'undefined' && CKEDITOR.instances) {
      const names = Object.keys(CKEDITOR.instances);
      if (names.length > 0) {
        for (const name of names) {
          const inst = CKEDITOR.instances[name];
          inst.setData(html);
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

  console.log('[エディタ] 方式2: HTML表示モード（textarea）を試行中...');
  const sourceBtn = page.locator('button#js-editorModeButton--source, button:has-text("HTML表示"), button:has-text("HTML編集"), [data-testid="source-mode-button"]').first();
  const sourceBtnVisible = await sourceBtn.isVisible().catch(() => false);
  if (sourceBtnVisible) {
    await sourceBtn.click();
    await page.waitForTimeout(2000);
  }

  const textareaSelectors = ['textarea.cke_source', 'textarea#amebloeditor', 'textarea[name="entry_text"]', '#entryText'];
  for (const sel of textareaSelectors) {
    const textarea = page.locator(sel).first();
    if (await textarea.isVisible().catch(() => false)) {
      await textarea.click();
      await textarea.fill(fullHtml);
      await page.waitForTimeout(500);
      const val = await textarea.inputValue().catch(() => '');
      if (val.length > 10) return true;
    }
  }

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

    if (page.url().includes('auth.user.ameba.jp') || page.url().includes('/signin') || page.url().includes('/login')) {
      console.log('ログインセッションが無効です。ID/パスワードによるログインを試みます...');
      if (!amebaId || !amebaPassword) {
        throw new Error('AMEBA_ID または AMEBA_PASSWORD が設定されていません。またCookieセッションも無効です。');
      }

      await page.goto('https://dauth.user.ameba.jp/login/ameba', { waitUntil: 'domcontentloaded' });
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

      const submitBtn = page.locator('button.js-submit-button, button[type="submit"], input[type="submit"]').first();
      await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
      await submitBtn.click();
      await page.waitForTimeout(5000);

      await page.goto('https://blog.ameba.jp/ucs/entry/srventryinsertinput.do', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
    }

    console.log('エディタ画面URL:', page.url());
    console.log('エディタ画面タイトル:', await page.title());

    console.log('記事タイトルを入力中...');
    const titleInput = page.locator('input[name="entry_title"], #entryTitle, textarea[data-testid="entry-title-input"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 30000 });
    await titleInput.fill(title);
    console.log(`タイトル「${title}」を入力しました。`);

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

    console.log('本文HTMLを入力中...');
    const editorSuccess = await injectEditorContent(page, fullHtml);
    if (!editorSuccess) {
      throw new Error('エディタへの本文入力に全方式で失敗しました。');
    }

    console.log('ハッシュタグを設定中...');
    const formattedTags = tags.map(t => t.startsWith('#') ? t : `#${t}`).join(' ');
    await page.evaluate((tagStr) => {
      const tagInput = document.querySelector('input[name="hashtag"], #js-hashtag-input');
      if (tagInput) {
        tagInput.value = tagStr;
        tagInput.dispatchEvent(new Event('input', { bubbles: true }));
        tagInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, formattedTags).catch(() => {});

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    console.log('テスト実行のため、投稿前待機をスキップします。');

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

    // --- AMEBA フォームの確定と送信処理 ---
    console.log('「投稿する」処理を実行中...');
    const postBtn = page.locator('button.js-submitButton:has-text("投稿する")').first();
    const isPostBtnVisible = await postBtn.isVisible().catch(() => false);

    if (isPostBtnVisible) {
      console.log('Playwright: 「投稿する」ボタンを検出しました。スクロールとクリックを実行します...');
      await postBtn.scrollIntoViewIfNeeded().catch(() => {});
      await postBtn.click({ force: true }).catch(async () => {
        await postBtn.evaluate(b => b.click());
      });

      console.log('「投稿する」ボタンをクリックしました。モーダルのアニメーション完了を待機中...');
      await page.waitForTimeout(2000);

      // モーダル内のすべての要素とボタン構造を詳細ログ出力
      const modalElementsDebug = await page.evaluate(() => {
        const modal = document.querySelector('.CoverConfirmModal, .ucsCommonModal');
        if (!modal) return 'モーダルが見つかりません';
        const els = [...modal.querySelectorAll('button, a, div, span, input')];
        return els.map(e => ({
          tag: e.tagName,
          class: e.className?.slice?.(0, 50) || '',
          text: e.innerText?.trim()?.slice?.(0, 30) || '',
          id: e.id || ''
        })).filter(e => e.text.length > 0);
      }).catch(() => []);
      console.log('モーダル内全要素一覧:', JSON.stringify(modalElementsDebug, null, 2));

      // タグ名を問わず「カバーなしで投稿」「このまま投稿」「設定せずに投稿」のテキストを持つ要素を全探索して直接クリック
      const targetElementClicked = await page.evaluate(() => {
        const modal = document.querySelector('.CoverConfirmModal, .ucsCommonModal') || document.body;
        const allElements = [...modal.querySelectorAll('button, a, span, div, input')];
        
        let target = allElements.find(e => e.innerText?.trim()?.includes('カバーなしで投稿'));
        if (!target) {
          target = allElements.find(e => e.innerText?.trim()?.includes('設定せずに投稿') || e.innerText?.trim()?.includes('このまま投稿'));
        }
        if (!target) {
          target = allElements.find(e => e.tagName === 'BUTTON' && e.innerText?.trim()?.includes('投稿'));
        }

        if (target) {
          const text = target.innerText?.trim();
          const parentBtn = target.closest('button') || target.closest('a') || target;
          
          parentBtn.click();
          parentBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          parentBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          parentBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          parentBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { success: true, text: text, tag: parentBtn.tagName };
        }
        return { success: false };
      }).catch((err) => ({ success: false, error: err.message }));

      console.log('モーダル要素クリック実行結果:', JSON.stringify(targetElementClicked));

      if (targetElementClicked.success) {
        console.log(`【確定成功】モーダル要素 [${targetElementClicked.text}] (${targetElementClicked.tag}) を直接クリックしました！`);
        console.log('投稿完了画面への遷移を25秒間待機中...');
        await page.waitForNavigation({ timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(4000);
      } else {
        console.log('モーダル要素の自動検出に失敗。Playwrightの直接ロケータで試行します...');
        const coverBtn = page.locator('*:has-text("カバーなしで投稿")').first();
        if (await coverBtn.isVisible().catch(() => false)) {
          await coverBtn.click({ force: true }).catch(() => {});
          await page.waitForNavigation({ timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(3000);
        }
      }
    }

    await page.waitForTimeout(3000);
    let currentUrl = page.url();
    console.log('1次試行後のURL:', currentUrl);

    if (currentUrl.includes('srventryinsertinput.do')) {
      console.log('まだ投稿入力画面です。JSによる正確な「投稿する」ボタンクリックを発行します...');

      const jsSubmitResult = await page.evaluate(() => {
        const allBtns = [...document.querySelectorAll('button, input[type="submit"]')];
        const postBtn = allBtns.find(b => b.innerText?.trim() === '投稿する' || b.value === '投稿する');

        if (postBtn) {
          postBtn.click();
          return { type: 'exact_post_click', text: postBtn.innerText };
        }

        const modalBtn = document.querySelector('.CoverConfirmModal button, .ucsCommonModal button');
        if (modalBtn) {
          modalBtn.click();
          return { type: 'modal_button_click', text: modalBtn.innerText };
        }

        return { type: 'none' };
      }).catch(e => ({ type: 'error', error: e.message }));

      console.log('JS代替処理結果:', JSON.stringify(jsSubmitResult));
      await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      currentUrl = page.url();
      console.log('2次試行後のURL:', currentUrl);
    }

    if (currentUrl.includes('entryend') || currentUrl.includes('complete') || !currentUrl.includes('srventryinsertinput.do')) {
      console.log('【投稿成功】記事の投稿完了画面への遷移を確認しました！');
    } else {
      const pageDiagnostics = await page.evaluate(() => {
        const errors = [...document.querySelectorAll('.c-errorMessage, [class*="error"], [class*="Error"], [class*="alert"], .spui-Text--danger')]
          .map(el => el.innerText?.trim())
          .filter(t => t && t.length > 0 && !t.includes('Twitter') && !t.includes('Facebook'));
        
        const modals = [...document.querySelectorAll('.c-modal, [class*="modal"], [class*="dialog"]')]
          .map(m => m.innerText?.trim())
          .filter(t => t && t.length > 0);

        return {
          errors,
          modals,
          activeElement: document.activeElement ? { tag: document.activeElement.tagName, class: document.activeElement.className } : null
        };
      }).catch(() => ({ errors: [], modals: [] }));

      console.error('【投稿失敗デバッグ情報】:', JSON.stringify(pageDiagnostics, null, 2));
      throw new Error(`投稿画面からの遷移に失敗しました。検出エラー: ${pageDiagnostics.errors.join(' | ') || 'なし'}`);
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
