import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import { chromium } from 'playwright';
import 'dotenv/config';
import fs from 'fs';

// ユーティリティ: 指定ミリ秒待機
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 投稿済み商品のコード/URLを保存・読み込みする関数（重複防止）
function getPostedItems() {
  const filePath = './posted_items.json';
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function savePostedItem(itemUrl) {
  const posted = getPostedItems();
  if (!posted.includes(itemUrl)) {
    posted.push(itemUrl);
    // 最新50件のみ保持
    if (posted.length > 50) posted.shift();
    fs.writeFileSync('./posted_items.json', JSON.stringify(posted, null, 2));
  }
}

// プロフィールファイルの読み込み
function getProfileData() {
  const profilePath = './profile';
  if (fs.existsSync(profilePath)) {
    return fs.readFileSync(profilePath, 'utf-8');
  }
  return '';
}

// 不用なパーツ・付属品・オプションを除外する判定関数
function isMainProduct(item) {
  const name = item.itemName;
  const price = item.itemPrice;

  // NGキーワード（パーツ、部品、アクセサリー、専用ケース等）
  const ngKeywords = [
    '延長輪', 'パーツ', '部品', '交換', '専用レシピ', 'レシピ本',
    'カバーのみ', 'プレートのみ', 'ケースのみ', '枠のみ', 'コードのみ',
    'アダプター', '替', 'オプション', '追加用', '専用袋', 'お手入れ', '洗剤',
    '【部品】', '【パーツ】', '専用ボトル', '専用容器'
  ];

  for (const kw of ngKeywords) {
    if (name.includes(kw)) return false;
  }

  // 価格が安すぎる商品（付属品の可能性が高い）を排除（2,000円未満を除外）
  if (price < 2000) return false;

  return true;
}

// 長すぎる型番や注意書き・【ブラケット】をきれいにクレンジングする関数
function cleanProductName(name) {
  return name
    .replace(/【.*?】|\[.*?\]|（.*?）|\(.*?\)/g, '') // ブラケットや括弧内の文字を削除
    .replace(/※.*/g, '') // ※以降の注意書きを削除
    .replace(/送料無料|ポイント\d+倍|セール|在庫処分/gi, '')
    .trim()
    .slice(0, 30); // 読みやすいように30文字以内に整形
}

// 2つの商品が同じメーカー・同一型番・同製品の別ショップ出品でないかチェックする判定関数
function areItemsTooSimilar(itemA, itemB) {
  const nameA = itemA.itemName;
  const nameB = itemB.itemName;
  const cleanA = cleanProductName(nameA);
  const cleanB = cleanProductName(nameB);

  // 1. 完全一致
  if (cleanA === cleanB) return true;

  // 2. 代表的なブランド・メーカー名の抽出と一致チェック
  const brands = [
    'アイリスオーヤマ', '山善', 'YAMAZEN', 'タイジ', 'レコルト', 'recolte',
    'プエル', 'BRUNO', 'ブルーノ', '象印', 'ZOJIRUSHI', 'パナソニック', 'Panasonic',
    'ライソン', 'LITHON', '岩谷', 'イワタニ', 'Iwatani', 'タイガー', 'TIGER',
    'コイズミ', 'KOIZUMI', 'テスコム', 'TESCOM', 'ヒロコーポレーション'
  ];

  for (const b of brands) {
    if (nameA.toUpperCase().includes(b.toUpperCase()) && nameB.toUpperCase().includes(b.toUpperCase())) {
      return true; // 同じメーカー同士なら類似とみなして再選出
    }
  }

  // 3. 型番の共通部分チェック (例: PTY-24-R など)
  const modelRegex = /[A-Z0-9]{3,}-[A-Z0-9]{2,}/gi;
  const modelsA = nameA.match(modelRegex) || [];
  const modelsB = nameB.match(modelRegex) || [];
  for (const mA of modelsA) {
    if (modelsB.includes(mA)) return true;
  }

  return false;
}

// 1. 楽天APIから2つの異なるメイン商品情報（比較用）とアフィリエイトリンクを取得
async function fetchRakutenItemPair(keyword) {
  const appId = process.env.RAKUTEN_APPLICATION_ID;
  const affId = process.env.RAKUTEN_AFFILIATE_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;

  if (!appId || !accessKey) {
    throw new Error('RAKUTEN_APPLICATION_ID または RAKUTEN_ACCESS_KEY が設定されていません。');
  }

  let url = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?format=json&keyword=${encodeURIComponent(keyword)}&hits=30&applicationId=${appId}&accessKey=${accessKey}`;
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

  const postedList = getPostedItems();

  // ① パーツや付属品を除外し、メイン家電本体のみをフィルタリング
  const mainProducts = data.Items.filter(i => isMainProduct(i.Item));

  // ② 過去に投稿されていない商品に絞る
  const availableItems = mainProducts.filter(i => !postedList.includes(i.Item.affiliateUrl || i.Item.itemUrl));

  const pool = availableItems.length >= 2 ? availableItems : (mainProducts.length >= 2 ? mainProducts : data.Items);

  if (pool.length < 2) return null;

  // 商品Aを選択
  const shuffle = pool.sort(() => 0.5 - Math.random());
  const itemA = shuffle[0].Item;

  // 商品Aと「メーカーも型番も異なる」商品Bを探す
  let itemB = null;
  for (let i = 1; i < shuffle.length; i++) {
    const candidate = shuffle[i].Item;
    if (!areItemsTooSimilar(itemA, candidate)) {
      itemB = candidate;
      break;
    }
  }

  // もし異メーカーが見つからなければ、2番目の候補をフォールバック使用
  if (!itemB) {
    itemB = shuffle[1].Item;
  }

  // 投稿済みリストに保存
  savePostedItem(itemA.affiliateUrl || itemA.itemUrl);
  savePostedItem(itemB.affiliateUrl || itemB.itemUrl);

  console.log(`[比較対決設定] 商品A: ${itemA.itemName.slice(0, 25)} VS 商品B: ${itemB.itemName.slice(0, 25)}`);

  return {
    itemA: {
      itemName: itemA.itemName,
      cleanName: cleanProductName(itemA.itemName),
      itemUrl: itemA.affiliateUrl || itemA.itemUrl,
      imageUrl: itemA.mediumImageUrls?.[0]?.imageUrl || itemA.mediumImageUrls?.[0] || '',
      price: itemA.itemPrice
    },
    itemB: {
      itemName: itemB.itemName,
      cleanName: cleanProductName(itemB.itemName),
      itemUrl: itemB.affiliateUrl || itemB.itemUrl,
      imageUrl: itemB.mediumImageUrls?.[0]?.imageUrl || itemB.mediumImageUrls?.[0] || '',
      price: itemB.itemPrice
    }
  };
}

// 2. AIで2商品比較型記事の本文・タイトル・ハッシュタグを生成
async function generateArticlePair(itemPair) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;
  const profileContent = getProfileData();

  const nameA = itemPair.itemA.cleanName || itemPair.itemA.itemName.slice(0, 20);
  const nameB = itemPair.itemB.cleanName || itemPair.itemB.itemName.slice(0, 20);

  const priceDiff = Math.abs(itemPair.itemA.price - itemPair.itemB.price).toLocaleString();

  const prompt = `
以下の【プロフィール設定】と【2つの比較商品情報】を基に、読者が思わずクリックして夢中で読み進めてしまう、毒舌かつ親しみやすい「本音爆発の2商品徹底比較ブログ記事」を作成してください。

【プロフィール設定】:
${profileContent}

【比較商品A】:
- 正式名称: ${itemPair.itemA.itemName}
- 略称: ${nameA}
- 価格: ${itemPair.itemA.price.toLocaleString()}円

【比較商品B】:
- 正式名称: ${itemPair.itemB.itemName}
- 略称: ${nameB}
- 価格: ${itemPair.itemB.price.toLocaleString()}円

--------------------------------------------------
【絶対に守るべき執筆ガイドライン】:

1. **アフィリエイトリンク禁止・商品名のみ記載**:
   - **アフィリエイトリンクやHTMLカードは一切記述しないでください。** Ameba Pick機能で読者が購入できるように、文章内には純粋な「正式商品名」と「価格（〇〇円）」、そしてレビューテキストのみを記述してください。

2. **タイトル（スーパーフックタイトル）**:
   - 当たり障りのないタイトルは絶対不可。「【本音比較】」「落とし穴」「〇〇ならどっち？」「約${priceDiff}円差の真実」など、読者の疑問や購買欲を強烈に刺激する数字や感情表現を含めた28〜35文字のタイトルにしてください。
   - 例: 「【本音暴露】${nameA} vs ${nameB}！${priceDiff}円差の落とし穴と後悔しない選び方」
   - 例: 「家で極上ポタージュ飲むならどっち？${nameA}と${nameB}をガチ比較してみた」

3. **核心に触れた具体的な比較内容**:
   - 表面的なスペック紹介（価格や容量）だけで終わらせず、以下の具体的な使用シーンの核心に踏み込んで比較してください：
     - ① **お手入れ・洗やすさの違い**（刃の洗いやすさ、本体の軽さ・パーツ分離ができるか等のストレス差）
     - ② **機能と作れるメニューの差**（保温・予約機能、14役多機能 vs シンプルポタージュ機能の差）
     - ③ **容量と生活シーンの体感差**（1000ml＝家族みんな・作り置き vs 700ml＝1〜2人で使い切り）
     - ④ **約${priceDiff}円の価格差を出す価値が本当にあるかどうかの本音判定**

4. **レイアウトと読みやすさ（改行重視）**:
   - **句点（。）のあとや会話の節目には必ず <br><br> を入れ、しっかり行間を空けてスマホで読みやすくしてください。**

5. **構成**:
   - 導入: 自宅での悩み・きっかけと2商品の提示
   - 「<h2>💡 ${nameA} の特徴と魅力</h2>」: 正式商品名・価格・特徴・メリット
   - 「<h2>💡 ${nameB} の特徴と魅力</h2>」: 正式商品名・価格・特徴・メリット
   - 「<h2>⚖️ 徹底比較！洗やすさ・機能・後片付けのリアルな差</h2>」: 核心比較
   - 「<h2>🍶 結論：あなたにピッタリなのはどっち？</h2>」: ズバリ本音の提案

--------------------------------------------------
以下のJSON形式のみで出力してください（Markdownコードブロック表記不可）：
{
  "title": "強烈なスーパーフックタイトル",
  "contentHtml": "<p>導入文...</p><br><br><h2>💡 ...</h2>...",
  "tags": ["家電比較", "おうち居酒屋", "本音レビュー", "楽天おすすめ"]
}
`;

  // --- A. Gemini API 試行 ---
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
        console.log(`[AI生成] Gemini (${modelName}) で比較記事の生成に成功！`);
        return article;
      } catch (err) {
        console.log(`[Gemini API (${modelName}) エラー]: ${err.message}`);
      }
    }
  }

  // --- B. Groq API 試行 ---
  if (groqApiKey) {
    const groqModels = [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B (instant)' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' }
    ];
    const groq = new Groq({ apiKey: groqApiKey });

    for (const m of groqModels) {
      try {
        console.log(`[Groq API] モデル ${m.name} を試行中...`);
        const chatCompletion = await groq.chat.completions.create({
          messages: [
            { role: 'system', content: 'あなたはAmebaブログの人気ブロガーです。要求されたJSON形式のみで回答してください。' },
            { role: 'user', content: prompt }
          ],
          model: m.id,
          response_format: { type: 'json_object' }
        });
        const text = chatCompletion.choices[0]?.message?.content || '';
        const article = JSON.parse(text);
        console.log(`[AI生成] Groq (${m.name}) で比較記事の生成に成功！`);
        return article;
      } catch (err) {
        console.log(`[Groq API (${m.name}) エラー]: ${err.message}`);
      }
    }
  }

  // --- C. フォールバック記事生成 ---
  console.log('AI API不可のため、比較フォールバック記事を生成します。');
  const title = `【比較】${nameA} VS ${nameB} どっちが買い？`;

  const contentHtml = `
<p>家で美味しいおつまみを楽しみながら飲む時間って最高ですよね。<br><br>でも、「どの卓上アイテムを選べば後悔しないんだろう……」と悩むことってありませんか？</p>

<br><br>
<h2>💡 ${nameA} の特徴と魅力</h2>
<p>サクッと準備して一人飲みを楽しみたいなら、コンパクトで扱いやすいタイプが重宝します。<br><br>手軽さと使い勝手のバランスが非常に優れていますよ。</p>

<br><br>
<h2>💡 ${nameB} の特徴と魅力</h2>
<p>家族や友人とおうち宴会を楽しみたいなら、一度に調理できる容量や火力が重要になります。<br><br>しっかり調理したい方にはピッタリの仕様ですね。</p>

<br><br>
<h2>⚖️ どちらを選ぶべき？比較まとめ</h2>
<p>手軽さとコスパを最優先するなら商品A、機能性や容量にこだわるなら商品Bが間違いなさそうです。<br><br>現在のセール価格や獲得できる還元ポイントは商品詳細からチェックできますので、気になった方はぜひ覗いてみてくださいね！</p>
`;

  return {
    title: title,
    contentHtml: contentHtml,
    tags: ["卓上家電", "おうち居酒屋", "比較レビュー", "楽天おすすめ"]
  };
}

// エディタ本文にHTMLを注入する関数
async function injectEditorContent(page, fullHtml) {
  console.log('[エディタ] CKEditor.setData() を試行中...');
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
    console.log(`[エディタ] CKEditor.setData() 成功`);
    await page.waitForTimeout(1000);
    return true;
  }

  return false;
}

// 3. PlaywrightによるAmeba自動投稿処理（下書き保存）
async function postToAmeba(title, rawContentHtml, tags, itemPair) {
  const amebaId = process.env.AMEBA_ID;
  const amebaPassword = process.env.AMEBA_PASSWORD;
  const amebaCookieJson = process.env.AMEBA_COOKIES;

  // 「ここにアフィリエイトリンク」などのプレースホルダー文字列を強制置換・排除
  let cleanContent = rawContentHtml.replace(/（ここに.*?リンク.*?）|【ここに.*?リンク.*?】|ここにアフィリエイトリンク|\[.*?アフィリエイト.*?\]/g, '');

  // 楽天アフィリエイトリンクカードは挿入せず、純粋な記事本文のみを使用（Ameba Pick手動掲載用）
  const fullHtml = cleanContent;

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
      console.log('AMEBA_COOKIES読み込み失敗:', e.message);
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
        throw new Error('AMEBA_ID または AMEBA_PASSWORD が設定されていません。');
      }

      await page.goto('https://dauth.user.ameba.jp/login/ameba', { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="accountId"], #accountId', amebaId);
      await page.fill('input[name="password"], #password', amebaPassword);
      await page.click('button.js-submit-button, button[type="submit"]');
      await page.waitForTimeout(5000);

      await page.goto('https://blog.ameba.jp/ucs/entry/srventryinsertinput.do', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
    }

    console.log('記事タイトルを入力中...');
    const titleInput = page.locator('input[name="entry_title"], #entryTitle, textarea[data-testid="entry-title-input"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 30000 });
    await titleInput.fill(title);

    console.log('本文HTMLを入力中...');
    const editorSuccess = await injectEditorContent(page, fullHtml);
    if (!editorSuccess) {
      throw new Error('エディタへの本文入力に失敗しました。');
    }

    console.log('ハッシュタグおよびカバー画像URLを設定中...');
    const formattedTags = tags.map(t => t.startsWith('#') ? t : `#${t}`).join(' ');
    
    // ハッシュタグ設定 ＆ カバー画像URL（image_url）に商品Aの画像URLを設定してモーダルをスキップさせる
    await page.evaluate(({ tagStr, coverUrl }) => {
      const tagInput = document.querySelector('input[name="hashtag"], #js-hashtag-input');
      if (tagInput) {
        tagInput.value = tagStr;
        tagInput.dispatchEvent(new Event('input', { bubbles: true }));
        tagInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      let imgInput = document.querySelector('input[name="image_url"]');
      if (!imgInput) {
        imgInput = document.createElement('input');
        imgInput.type = 'hidden';
        imgInput.name = 'image_url';
        document.forms[0]?.appendChild(imgInput);
      }
      imgInput.value = coverUrl;
    }, { tagStr: formattedTags, coverUrl: itemPair.itemA.imageUrl }).catch(() => {});

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    console.log('CKEditorデータをフォームに同期中...');
    await page.evaluate(() => {
      if (typeof CKEDITOR !== 'undefined' && CKEDITOR.instances) {
        for (const name in CKEDITOR.instances) {
          CKEDITOR.instances[name].updateElement();
        }
      }
    }).catch(() => {});
    await page.waitForTimeout(500);

    // --- AMEBA 安全運用：下書き保存フロー ---
    console.log('「下書き保存（publish_flg=0）」処理を実行中...');

    // 1. 事前にフォーム内の publish_flg を "0" (下書き保存) に固定設定
    await page.evaluate(() => {
      if (typeof CKEDITOR !== 'undefined' && CKEDITOR.instances) {
        for (const name in CKEDITOR.instances) {
          CKEDITOR.instances[name].updateElement();
        }
      }
      const forms = document.forms;
      for (const form of forms) {
        let pubInput = form.querySelector('input[name="publish_flg"]');
        if (!pubInput) {
          pubInput = document.createElement('input');
          pubInput.type = 'hidden';
          pubInput.name = 'publish_flg';
          form.appendChild(pubInput);
        }
        pubInput.value = '0'; // 0 = 下書き保存
      }
    }).catch(() => {});

    // 2. Amebaエディタの「下書き保存」ボタンを探索してクリック
    const draftBtn = page.locator('button.js-submitButton:has-text("下書き保存"), button:has-text("下書き保存")').first();
    const draftBtnVisible = await draftBtn.isVisible().catch(() => false);

    if (draftBtnVisible) {
      console.log('「下書き保存」ボタンをクリックします...');
      await draftBtn.scrollIntoViewIfNeeded().catch(() => {});
      await draftBtn.click({ force: true }).catch(async () => {
        await draftBtn.evaluate(b => b.click());
      });
    } else {
      console.log('JS経由で下書き保存フォームを送信します...');
      await page.evaluate(() => {
        const form = document.querySelector('form[action*="srventryinsertend.do"]') || document.forms[0];
        if (form) {
          let pubInput = form.querySelector('input[name="publish_flg"]');
          if (pubInput) pubInput.value = '0';
          form.submit();
        }
      }).catch(() => {});
    }

    await page.waitForTimeout(4000);

    const finalUrl = page.url();
    console.log('保存完了後のURL:', finalUrl);

    console.log('--------------------------------------------------');
    console.log('【安全運用成功】生成した比較記事を Ameba の「下書き」として正常保存しました！');
    console.log('人間に手による最終チェック・推演が可能です。');
    console.log('--------------------------------------------------');

  } catch (error) {
    console.error('下書き保存処理エラー:', error);
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
  const itemPair = await fetchRakutenItemPair(randomKeyword);

  if (!itemPair) {
    console.log('対象商品が2つ以上見つかりませんでした。スキップします。');
    return;
  }

  console.log(`比較商品A:「${itemPair.itemA.itemName.slice(0, 20)}...」`);
  console.log(`比較商品B:「${itemPair.itemB.itemName.slice(0, 20)}...」`);
  console.log('2商品比較記事を生成します...');

  const article = await generateArticlePair(itemPair);

  console.log('Amebaへの自動投稿処理を開始します...');
  await postToAmeba(article.title, article.contentHtml, article.tags, itemPair);
}

main();
