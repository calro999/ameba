import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import { chromium } from 'playwright';
import 'dotenv/config';
import fs from 'fs';
import { marked } from 'marked';

// markedの設定（改行を <br> に自動変換する）
marked.setOptions({
  gfm: true,
  breaks: true
});

// Markdown記号が含まれていた場合に完全にきれいなHTMLタグに落とし込む変換ヘルパー
function convertToCleanHtml(rawContent) {
  if (!rawContent) return '';
  
  // Markdown（#や##や---や**など）を標準HTMLタグ（<h2>, <h3>, <hr>, <strong>, <p>）に変換
  let html = marked.parse(rawContent);

  // Amebaブログの仕様上、本文内の <h1> はすべて <h2> に置き換える（<h1>はブログタイトル専用のため）
  html = html
    .replace(/<h1[^>]*>/gi, '<h2>')
    .replace(/<\/h1>/gi, '</h2>');

  return html;
}

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

// 不用なパーツ・付属品・オプション・業務用大型機器を除外する判定関数
function isMainProduct(item) {
  const name = item.itemName;
  const price = item.itemPrice;

  // NGキーワード（パーツ、部品、業務用大型機器、店舗用、アクセサリー等）
  const ngKeywords = [
    '延長輪', 'パーツ', '部品', '交換', '専用レシピ', 'レシピ本',
    'カバーのみ', 'プレートのみ', 'ケースのみ', '枠のみ', 'コードのみ',
    'アダプター', '替', 'オプション', '追加用', '専用袋', 'お手入れ', '洗剤',
    '【部品】', '【パーツ】', '専用ボトル', '専用容器',
    '業務用', '店舗用', '施設用', '大容量フライヤー', '三相200V', '単相200V',
    '厨房', 'プロ用', '10L', '12L', '15L', '20L', '大型フライヤー'
  ];

  for (const kw of ngKeywords) {
    if (name.includes(kw)) return false;
  }

  // 価格が安すぎる商品（付属品の可能性が高い）を排除（2,000円未満を除外）
  if (price < 2000) return false;

  return true;
}

// 長すぎる型番やSEOキーワード・重複単語を徹底除去し、綺麗な「ブランド名＋商品名」を抽出する関数
function cleanProductName(name) {
  if (!name) return '';

  // 1. 『』や「」で囲まれたブランド名・商品愛称があればそれを優先抽出
  const quoteMatch = name.match(/『(.*?)』|「(.*?)」/);
  if (quoteMatch) {
    const quoted = (quoteMatch[1] || quoteMatch[2]).trim();
    if (quoted.length >= 2 && !/送料無料|ポイント|予約|限定|楽天/.test(quoted)) {
      return quoted;
    }
  }

  let cleaned = name
    // 【...】 [ ...] （...） (...) 内のノイズテキスト削除
    .replace(/【.*?】|\[.*?\]|（.*?）|\(.*?\)/g, ' ')
    .replace(/※.*/g, '') // ※以降の注意書き削除
    .replace(/送料無料|ポイント\d+倍|実質\d+円|セール|在庫処分|あす楽|即納|予約|限定|メーカー直送|代引不可|着脱式|破壁機|家庭用|卓上|電気|料理|調理|簡単|便利|多機能/gi, ' ')
    .replace(/[\s\t\n]+/g, ' ')
    .trim();

  // 単語の重複排除（例: 「保温プレート 保温プレート」のような重複を自動除去）
  const words = cleaned.split(' ').filter(w => w.length > 0);
  const uniqueWords = [];
  for (const w of words) {
    if (!uniqueWords.includes(w) && !uniqueWords.some(uw => uw.includes(w) || w.includes(uw))) {
      uniqueWords.push(w);
    }
  }

  if (uniqueWords.length > 0) {
    let result = uniqueWords.slice(0, 2).join(' ');
    if (result.length > 20) {
      result = uniqueWords[0];
    }
    return result.trim();
  }

  return name.slice(0, 18).trim();
}

// 2つの商品が同じメーカー・同一型番・同製品の別ショップ出品でないかチェックする判定関数
function areItemsTooSimilar(itemA, itemB) {
  if (!itemA || !itemB) return true;

  const urlA = itemA.affiliateUrl || itemA.itemUrl || '';
  const urlB = itemB.affiliateUrl || itemB.itemUrl || '';
  if (urlA && urlB && urlA === urlB) return true;

  const codeA = itemA.itemCode || '';
  const codeB = itemB.itemCode || '';
  if (codeA && codeB && codeA === codeB) return true;

  const nameA = itemA.itemName || '';
  const nameB = itemB.itemName || '';
  const cleanA = cleanProductName(nameA);
  const cleanB = cleanProductName(nameB);

  // 1. クリーン名が完全一致、または一方に他方が含まれる（例: 「成城石井 ミックスナッツ」と「成城石井 ミックスナッツ 大容量」）
  if (cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;

  // 2. 代表的なブランド・メーカー・酒造名の抽出と一致チェック
  const brands = [
    'アイリスオーヤマ', '山善', 'YAMAZEN', 'タイジ', 'レコルト', 'recolte',
    'プエル', 'BRUNO', 'ブルーノ', '象印', 'ZOJIRUSHI', 'パナソニック', 'Panasonic',
    'ライソン', 'LITHON', '岩谷', 'イワタニ', 'Iwatani', 'タイガー', 'TIGER',
    'コイズミ', 'KOIZUMI', 'テスコム', 'TESCOM', 'ヒロコーポレーション',
    '成城石井', 'サントリー', 'ニッカ', 'アサヒ', 'キリン', '宮城峡', '余市', '山崎', '白州', '響',
    '手取川', '立山', '獺祭', '久保田', '八海山', '梵', '黒龍'
  ];

  for (const b of brands) {
    if (nameA.toUpperCase().includes(b.toUpperCase()) && nameB.toUpperCase().includes(b.toUpperCase())) {
      return true; // 同じブランド・メーカー同士なら同一・類似とみなして除外
    }
  }

  // 3. 型番や主要英単語の一致
  const modelRegex = /[A-Z0-9]{3,}-[A-Z0-9]{2,}/gi;
  const modelsA = nameA.match(modelRegex) || [];
  const modelsB = nameB.match(modelRegex) || [];
  for (const mA of modelsA) {
    if (modelsB.includes(mA)) return true;
  }

  return false;
}

// 1. 楽天APIから2つのメイン商品情報（比較用）を取得
// 統一ルール:
// 【パターン1】別ジャンル卓上調理家電同士の対決（例: 卓上燻製機 vs 卓上調理ポット）
// 【パターン2】同ジャンルで「異なるブランド」同士の対決（例: ブランドAの燻製機 vs ブランドBの燻製機）
async function fetchRakutenItemPair(primaryObj) {
  const primaryKeyword = typeof primaryObj === 'object' ? primaryObj.keyword : primaryObj;
  const category = typeof primaryObj === 'object' ? primaryObj.category : 'appliance';

  const appId = process.env.RAKUTEN_APPLICATION_ID;
  const affId = process.env.RAKUTEN_AFFILIATE_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;

  if (!appId || !accessKey) {
    throw new Error('RAKUTEN_APPLICATION_ID または RAKUTEN_ACCESS_KEY が設定されていません。');
  }

  // 楽天API呼び出しヘルパー
  const searchRakuten = async (kw) => {
    let url = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?format=json&keyword=${encodeURIComponent(kw)}&hits=30&applicationId=${appId}&accessKey=${accessKey}`;
    if (affId) url += `&affiliateId=${affId}`;
    try {
      const res = await fetch(url);
      const json = await res.json();
      if (json && json.Items && json.Items.length > 0) {
        return json.Items.filter(i => isMainProduct(i.Item));
      }
    } catch (e) {
      console.log(`[Rakuten API エラー (${kw})]:`, e.message);
    }
    return [];
  };

  const postedList = getPostedItems();

  let itemA = null;
  let itemB = null;

  console.log(`[比較対決モード] 同カテゴリ・異ブランド比較モード (検索キーワード: ${primaryKeyword}, カテゴリ: ${category})`);
  const items = (await searchRakuten(primaryKeyword)).filter(i => !postedList.includes(i.Item.affiliateUrl || i.Item.itemUrl));

  if (items.length >= 2) {
    const shuffle = items.sort(() => 0.5 - Math.random());
    itemA = shuffle[0].Item;

    // 異なるブランド・メーカーの候補を探す
    for (let i = 1; i < shuffle.length; i++) {
      const candidate = shuffle[i].Item;
      if (!areItemsTooSimilar(itemA, candidate)) {
        itemB = candidate;
        break;
      }
    }
    if (!itemB) itemB = shuffle[1].Item;
  } else {
    // 件数が足りない場合、同じカテゴリ内のキーワードから補填（異カテゴリ混入を防止）
    console.log(`[補填モード] キーワード「${primaryKeyword}」の件数不足のため、同カテゴリ内から代替検索`);
    let sameCategoryPool = [];
    if (category === 'liquor') sameCategoryPool = [...SAKE_KEYWORDS, ...WHISKY_KEYWORDS, ...WINE_KEYWORDS];
    else if (category === 'snack') sameCategoryPool = [...SWEET_SNACK_KEYWORDS, ...SAVORY_SNACK_KEYWORDS];
    else sameCategoryPool = TABLETOP_APPLIANCE_KEYWORDS;

    const altKw = sameCategoryPool.filter(k => k !== primaryKeyword)[Math.floor(Math.random() * sameCategoryPool.length)] || primaryKeyword;
    const itemsA = await searchRakuten(primaryKeyword);
    const itemsB = await searchRakuten(altKw);
    if (itemsA.length > 0 && itemsB.length > 0) {
      itemA = itemsA[0].Item;
      itemB = itemsB[0].Item;
    }
  }

  if (!itemA || !itemB) return null;

  // 投稿済みリストに保存
  savePostedItem(itemA.affiliateUrl || itemA.itemUrl);
  savePostedItem(itemB.affiliateUrl || itemB.itemUrl);

  console.log(`[比較対決設定確定] [カテゴリ:${category}] 商品A: ${cleanProductName(itemA.itemName)} VS 商品B: ${cleanProductName(itemB.itemName)}`);

  return {
    category,
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

// 投稿済みキーワードの記録・読み込み（「焼き鳥」「焼肉」などの連打を防止）
function getUsedKeywords() {
  const filePath = './used_keywords.json';
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveUsedKeyword(keyword) {
  const used = getUsedKeywords();
  used.push(keyword);
  if (used.length > 8) used.shift();
  fs.writeFileSync('./used_keywords.json', JSON.stringify(used, null, 2));
}

// 実用的で一人飲み・家飲みに活躍する卓上調理家電キーワード群（約33.3%）
const TABLETOP_APPLIANCE_KEYWORDS = [
  '卓上たこ焼き器',
  '卓上流しそうめん器',
  '卓上おでん鍋',
  '卓上焼き鳥焼き器',
  '卓上電気酒燗器',
  '卓上電気せいろ',
  '卓上串揚げ器',
  '卓上保温プレート',
  '卓上燻製器',
  '卓上チーズヒーター',
  '卓上フォンデュ鍋',
  '卓上卓上一人鍋',
  '卓上電気グリル鍋',
  '卓上ホットサンドメーカー',
  '卓上ワッフルメーカー',
  '卓上フィッシュロースター',
  '卓上コンパクトホットプレート',
  '卓上クレープメーカー',
  '卓上燻製スモーカー',
  '卓上ミニロースター'
];

// ふるさと納税・おつまみお菓子キーワード群（甘いもの同士、塩っぽいもの同士）（約33.3%）
const SWEET_SNACK_KEYWORDS = [
  'ふるさと納税 チョコレート',
  'ふるさと納税 ケーキ 焼菓子',
  'ふるさと納税 プリン スイーツ',
  'ふるさと納税 クッキー',
  'ふるさと納税 カステラ',
  'ふるさと納税 和菓子 干し柿'
];

const SAVORY_SNACK_KEYWORDS = [
  'ふるさと納税 お煎餅 せんべい',
  'ふるさと納税 ナッツ おつまみ',
  'ふるさと納税 ポテトチップス お菓子',
  'ふるさと納税 柿の種 つまみ',
  'ふるさと納税 チーズ おつまみ',
  'ふるさと納税 ドライフルーツ ナッツ'
];

// 本格お酒銘柄比較用キーワード群（日本酒・ウイスキー・ワイン等の銘柄同士対決）（約33.3%）
const SAKE_KEYWORDS = [
  '日本酒 720ml 純米大吟醸 銘柄',
  '日本酒 吟醸 飲み比べ 銘柄',
  '日本酒 特別純米 銘柄'
];

const WHISKY_KEYWORDS = [
  'ウイスキー シングルモルト 銘柄 700ml',
  'スコッチウイスキー 銘柄',
  'ジャパニーズウイスキー 銘柄'
];

const WINE_KEYWORDS = [
  '赤ワイン フルボディ 銘柄',
  '白ワイン 辛口 銘柄',
  'スパークリングワイン 銘柄'
];

function selectRandomKeyword(excludeList = []) {
  const usedKeywords = getUsedKeywords();
  
  // 家電 33%、ふるさと納税お菓子 33%、お酒銘柄 33% の均等確率
  const rand = Math.random();
  
  let keywordPool = [];
  let category = 'appliance';

  if (rand < 0.33) {
    // 卓上調理家電（33%）
    keywordPool = TABLETOP_APPLIANCE_KEYWORDS;
    category = 'appliance';
  } else if (rand < 0.66) {
    // ふるさと納税お菓子（33%）：甘いもの同士50% / 塩っぽいもの同士50%
    keywordPool = Math.random() < 0.5 ? SWEET_SNACK_KEYWORDS : SAVORY_SNACK_KEYWORDS;
    category = 'snack';
  } else {
    // 本格お酒銘柄（34%）：日本酒、ウイスキー、ワインから選出
    const liquorRand = Math.random();
    if (liquorRand < 0.34) keywordPool = SAKE_KEYWORDS;
    else if (liquorRand < 0.67) keywordPool = WHISKY_KEYWORDS;
    else keywordPool = WINE_KEYWORDS;
    category = 'liquor';
  }

  const available = keywordPool.filter(k => !usedKeywords.includes(k) && !excludeList.includes(k));
  const pool = available.length > 0 ? available : keywordPool.filter(k => !excludeList.includes(k));
  const chosen = pool[Math.floor(Math.random() * pool.length)] || keywordPool[0];
  saveUsedKeyword(chosen);
  return { keyword: chosen, category };
}

// 2. AIで2商品比較型記事の本文・タイトル・ハッシュタグを生成
async function generateArticlePair(itemPair) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;
  const profileContent = getProfileData();

  const fullNameA = itemPair.itemA.itemName;
  const fullNameB = itemPair.itemB.itemName;
  const priceA = itemPair.itemA.price.toLocaleString();
  const priceB = itemPair.itemB.price.toLocaleString();

  const nameA = itemPair.itemA.cleanName || fullNameA.slice(0, 18);
  const nameB = itemPair.itemB.cleanName || fullNameB.slice(0, 18);

  const priceDiff = Math.abs(itemPair.itemA.price - itemPair.itemB.price).toLocaleString();

  const category = itemPair.category || 'appliance';
  let pattern = {};

  if (category === 'liquor') {
    // 【お酒銘柄専用パターン群】味・香り・口当たり・余韻・おつまみとの相性にトコトンフォーカス！
    const PATTERNS_LIQUOR = [
      {
        titleTemplate: `【本音で飲み比べ迷い】『${nameA}』と『${nameB}』、次に開拓するならどっち？`,
        introIdea: `最近お酒を色々と飲み比べてみたいなーって思ってるんですよね。\n\nじっくり味わえる本格的なお酒を開拓したくて。\n\nでも美味しそうな銘柄が多すぎてどれから手をつけるべきか選べない...`,
        h2_a: `## 芳醇な香りと洗練された味わいの『${nameA}』`,
        h2_b: `## 独特のコクと口当たりの良さが光る『${nameB}』`,
        h2_diff: `## 価格差は約${priceDiff}円。この味と品質の差をどう考える？`,
        h2_eval: `## 呑んだ時の風味と後味（余韻）の違いを比べる`,
        h2_scene: `## どんなおつまみやシーンで呑むのが一番引き立つか`,
        h2_care: `## 保存方法や飲み頃（ロック・冷酒・ぬる燗など）の選びやすさ`,
        summaryHeadline: `## 結論：「どんな味わいの余韻を楽しみたいか」で選ぶのが一番納得できそう`
      },
      {
        titleTemplate: `晩酌でじっくり味わうなら『${nameA}』と『${nameB}』どっちの銘柄が幸せになれる？`,
        introIdea: `夜のゆっくりした時間に、グラスに注いで本気で味わいたいお酒を探して調べ直していました。\n\n気になった銘柄を2つまで絞り込んだものの、どっちも魅力的すぎて決められません。`,
        h2_a: `## スッキリとしたキレと上品な口当たりが魅力の『${nameA}』`,
        h2_b: `## 濃厚な旨味としっかりした呑みごたえが広がる『${nameB}』`,
        h2_diff: `## 約${priceDiff}円の差。普段の晩酌用か、ちょっと特別な日のためか`,
        h2_eval: `## 呑みやすさと香りの広がり方を比較してみる`,
        h2_scene: `## 毎日の晩酌タイムでダラダラ呑むのに合っているのは`,
        h2_care: `## 開封後の味の変化や保存のしやすさ`,
        summaryHeadline: `## 結局「自分の好きな風味のタイプ」に合わせて選ぶのが失敗しない`
      },
      {
        titleTemplate: `【銘柄対決】『${nameA}』VS『${nameB}』、呑み比べで先に試したいのはどっち？`,
        introIdea: `銘柄によって香りも旨味も全然違うから、お酒の世界って本当に奥が深くて楽しいですよね。\n\n今回は特に評価が高くて気になった2銘柄を真剣に比較中。`,
        h2_a: `## 華やかな香りが引き立つ、王道バランスの『${nameA}』`,
        h2_b: `## 個性的な風味と深い味わいがクセになる『${nameB}』`,
        h2_diff: `## 約${priceDiff}円の価格差。この銘柄ならではの価値を考える`,
        h2_eval: `## 口に含んだ瞬間の旨味と、喉越しのキレを比べる`,
        h2_scene: `## お刺身や肉料理など、合わせたい料理との相性`,
        h2_care: `## 飲み方のバリエーション（ロック・ストレート・割るなど）の豊富さ`,
        summaryHeadline: `## どちらも間違いなく旨いからこそ、自分の「今の気分」で決めるのが正解`
      }
    ];
    pattern = PATTERNS_LIQUOR[Math.floor(Math.random() * PATTERNS_LIQUOR.length)];
  } else if (category === 'snack') {
    // 【ふるさと納税お菓子専用パターン群】食感・甘み・塩気・満足感にフォーカス！
    const PATTERNS_SNACK = [
      {
        titleTemplate: `【ふるさと納税】家飲みのお供に『${nameA}』と『${nameB}』どっちのお菓子を選ぶ？`,
        introIdea: `お酒を飲む時って、美味しいおつまみやお菓子が欲しくなりますよね。\n\nコンビニで買うと結構高いし...と思ったら、楽天のふるさと納税なら実質罪悪感ゼロで買えちゃうことに気づいて！\n\nでも美味しそうなものが多すぎてどれにするか選べない...`,
        h2_a: `## 止まらない美味しさと素材の良さが際立つ『${nameA}』`,
        h2_b: `## 濃厚な味わいで酒乗りが抜群の『${nameB}』`,
        h2_diff: `## 寄付金額（または価格）の差。お得感と内容量で比較`,
        h2_eval: `## 食べた時の食感・甘み・塩気のバランスを比べる`,
        h2_scene: `## ウイスキーやハイボール、ビールと合わせた時の満足感`,
        h2_care: `## 個包装か大袋か、保存のしやすさと賞味期限`,
        summaryHeadline: `## 呑むお酒の種類や「普段どんなおつまみを欲するか」で選ぶのが一番`
      },
      {
        titleTemplate: `お酒が進む絶品お菓子対決！『${nameA}』と『${nameB}』で迷った結果...`,
        introIdea: `せっかく家で美味しく飲むなら、最高のおつまみ・お菓子を準備したいですよね。\n\nふるさと納税の返礼品で大人気の2つを見つけて、真剣に悩んでいます。`,
        h2_a: `## 一口食べるだけで満足度が高い、贅沢な『${nameA}』`,
        h2_b: `## ついつい手が伸びる香ばしさがたまらない『${nameB}』`,
        h2_diff: `## 約${priceDiff}円の価格差。量とクオリティのバランス`,
        h2_eval: `## 実際の味わいの濃さや食感の満足度を比較`,
        h2_scene: `## 夜のお酒タイムに少しずつつまむのに最適なのは`,
        h2_care: `## 届いた時の量と保管スペースのリアル`,
        summaryHeadline: `## 自分の好みの味わい（甘さ系か塩気系か）に合わせて選ぶと失敗しない`
      }
    ];
    pattern = PATTERNS_SNACK[Math.floor(Math.random() * PATTERNS_SNACK.length)];
  } else {
    // 【卓上調理家電専用パターン群】機能性・お手入れ・焼き上がり・居酒屋感にフォーカス！
    const PATTERNS_APPLIANCE = [
      {
        titleTemplate: `一人家飲みの相棒にするなら『${nameA}』と『${nameB}』どっちが快適？`,
        introIdea: `家での晩酌をちょっと楽しくするアイテムを探していて、卓上調理家電を色々調べていました。\n\n面白そうで便利そうな一人家飲み用のアイテムを見つけて、真剣に買おうか悩んでいます。`,
        h2_a: `## 卓上で手軽にアツアツが楽しめる『${nameA}』`,
        h2_b: `## 目の前で育てる焼き上がりのライブ感がたまらない『${nameB}』`,
        h2_diff: `## 約${priceDiff}円の価格差。手軽さと機能性の天秤`,
        h2_eval: `## 調理スピードや焼き上がりの香ばしさを比較`,
        h2_scene: `## 卓上に置いた時のサイズ感と一人飲みの収まりやすさ`,
        h2_care: `## プレートの取り外しや洗やすさ、煙・油跳ねのお手入れ`,
        summaryHeadline: `## 自分が「卓上でどんな家飲み風景を楽しみたいか」で選ぶのが一番`
      },
      {
        titleTemplate: `【卓上家電本音比較】『${nameA}』VS『${nameB}』、おうち居酒屋を開くなら？`,
        introIdea: `外飲みを減らして家でまったり飲む時間が増えたので、卓上家電を新調したくなりました。\n\n気になった2台を詳しく調べてみたものの、どっちも良さがあって決められません。`,
        h2_a: `## 多機能でいろんなおつまみに対応できる『${nameA}』`,
        h2_b: `## シンプルゆえに旨味を最大限に引き出す『${nameB}』`,
        h2_diff: `## 価格差は約${priceDiff}円。この差額をどう考える？`,
        h2_eval: `## 卓上での使いやすさと仕上がりのクオリティ`,
        h2_scene: `## 普段のおつまみ準備のラクさと楽しさ`,
        h2_care: `## 使った後の片付けの手間と収納のしやすさ`,
        summaryHeadline: `## 「使い勝手のラクさ」か「居酒屋感の雰囲気」かで選ぶのが正解`
      }
    ];
    pattern = PATTERNS_APPLIANCE[Math.floor(Math.random() * PATTERNS_APPLIANCE.length)];
  }

  const prompt = `
以下の【プロフィール設定】と【2つの比較対象商品情報】を基に、Amebaブログ用の本音比較ブログ記事を作成してください。
アフィリエイト感を絶対に排除し、夜中に一人でお酒やお茶を飲みながら「自分が本気でどちらを買うか真剣に悩んでいる」という個人の独白スタンスで書いてください。
絶対に商品をアピールしたり売り込もうとせず、あくまで「どっちも魅力的で選べない...」という目線で客観的に悩んでください。

【プロフィール設定】:
${profileContent}

【商品A情報】:
- 正式商品名: ${fullNameA}
- 略称・通称: ${nameA}
- 価格: ${priceA}円

【商品B情報】:
- 正式商品名: ${fullNameB}
- 略称・通称: ${nameB}
- 価格: ${priceB}円

--------------------------------------------------
【絶対に守るべきMarkdown構成＆スタンスルール】:

1. **商品名（略称）の記述ルール**:
   - 本文や見出しで商品名を記載するときは、必ず短く整えられた略称『${nameA}』および『${nameB}』だけを使用してください。
   - 重複した単語（例：「お煎餅 お煎餅」「日本酒 日本酒」など）は不自然なので絶対に書かないでください！

2. **タイトル**:
   - 必ず以下の指定タイトルテンプレートをそのまま出力してください。
   - タイトル: 「${pattern.titleTemplate}」

3. **文章スタンス・語り口・改行**:
   - **基本スタンス**: すべての記事において「自分で気になった商品を詳しく調べてはみたけど、どっちにするか決められないなー、どっちを次に買ってみようかなーと悩んでる」という個人ブログのリアルな空気感を徹底してください。
   - **アピール・押し売り禁止**: 「おすすめです！」「買いましょう！」などの言葉は絶対に使用禁止。売ろうとせず、純粋に迷ってください。
   - **CRITICAL（カテゴリ特化）**:
     ${category === 'liquor' ? `
     - 今回の比較対象は【本格的なお酒（日本酒・ウイスキー・ワイン等）】です！
     - 卓上家電の言葉（「卓上で焼く」「調理」「洗物」「プレート」等）は絶対に1文字も使わないでください！
     - **味・風味・香り・キレ・口当たり・後味（余韻）・呑み心地・おつまみ（刺身や肉など）との相性**にトコトンフォーカスして文章を書いてください！
     - 導入は「最近お酒を色々と飲み比べてみたいなーって思ってるんですよね。じっくり味わえる本格的なお酒を開拓したくて。でも美味しそうな銘柄が多すぎてどれから手をつけるべきか選べない...」という空気感を全開にしてください。
     ` : category === 'snack' ? `
     - 今回の比較対象は【ふるさと納税のおつまみ・お菓子】です！
     - 味・食感・甘み・塩気・お酒（ハイボールやビール）との相性にトコトンフォーカスしてください！
     - 導入は「ハイボール（やビール）を飲む時って、チョコやお煎餅のおつまみが欲しくなる。でもコンビニだと高いし...と思ったら楽天のふるさと納税で注文できると知って罪悪感ゼロで買えそう！でも美味しそうなものが多すぎてどちらにするか選べない...」という空気感を全開にしてください。
     ` : `
     - 今回の比較対象は【一人飲み用の卓上調理家電】です！
     - 卓上での使い勝手・焼き上がりの美味しさ・居酒屋感・片付けのお手入れにフォーカスしてください！
     - 導入は「面白そうで便利そうな一人家飲み用（卓上用）のアイテムを見つけて、真剣に買おうか悩んでいる」という空気感を出してください。
     `}
   - 句点「。」や独白の区切りごとに【必ず空行を1行挟んで改行】してください。
   - 心の声（例: **「え、これどっち買えばいいんだ？」**）や金額の差（例: **約${priceDiff}円**）は **太文字** にする。

4. **指定の見出し構成（h1 / # は本文中で使用禁止。綺麗な構成を維持）**:
   - 導入（${pattern.introIdea} の空気感・悩みスタンスで始める）
   - \`---\`
   - \`${pattern.h2_a}\` （※冒頭で1回だけ正式商品名『${fullNameA}』と価格${priceA}円を明記）
   - \`---\`
   - \`${pattern.h2_b}\` （※冒頭で1回だけ正式商品名『${fullNameB}』と価格${priceB}円を明記）
   - \`---\`
   - \`${pattern.h2_eval}\`
   - \`---\`
   - \`${pattern.h2_diff}\`
   - \`---\`
   - \`${pattern.h2_scene}\`
   - \`---\`
   - \`${pattern.h2_care}\`
   - \`---\`
   - \`## 正直、どっちに惹かれてる？\`
     - \`### ${nameA}に惹かれる理由\`
     - \`### ${nameB}に惹かれる理由\`
   - \`---\`
   - \`${pattern.summaryHeadline}\`
   - \`---\`
   - \`## まとめ\`
     - 文末の締めとして、**必ず以下の文言をそのまま入れて締めくくってください**:
       「どっちも良い点が多いから難しいなーもう少し考えてみるかな。一応今回悩んでた商品貼っておきます。皆ならどっち買う？」

--------------------------------------------------
【SEO / AI-SEO / GEO（生成AI検索最適化）徹底重視の執筆ガイドライン】:

1. **検索キーワードの自然な自然含有（SEO強化）**:
   - 比較する商品名『${nameA}』と『${nameB}』、およびそのジャンル（${category === 'liquor' ? '銘柄・味わい・飲み比べ' : category === 'snack' ? 'ふるさと納税・おつまみ・還元率' : '卓上家電・お手入れ・一人飲み'}）を本文中に自然に盛り込んでください。
   - 「どっちがおすすめ？」「違いは？」「比較」「口コミ」「メリット・デメリット」「価格差」といったユーザーが実際に検索エンジンやAIチャットで調べる自然な問いかけを独白内で自然に使用してください。

2. **AI検索（ChatGPT / Perplexity / Gemini）に引用されやすいGEO構造（信頼性・回答性）**:
   - 抽象的で一般的な説明ではなく、**具体的数値（価格差 約${priceDiff}円など）、具体的な使用シーン、味や機能の具体的な違い**を明記してください。
   - 「なぜ迷うのか」の対比理由を論理的かつ情熱的に記述し、AI検索エンジンが「この記事は両者の違いを的確に比較している高品質な一次情報」と判断できるように執筆してください。

3. **自然でAI臭さゼロの体験価値（E-E-A-T評価）**:
   - 定型的な商品カタログスペックの羅列は絶対に禁止。
   - 実際に生活に取り入れた時の「手軽さ」「満足感」「失敗したくない心理」をリアルなブロガーの言葉で表現してください。

--------------------------------------------------
以下のJSON形式のみで出力してください（Markdown表記の文字列としてcontentHtmlを出力）：
{
  "title": "${pattern.titleTemplate}",
  "contentHtml": "（指定された導入・見出し構成に沿ったMarkdown文章）",
  "tags": ["${category === 'liquor' ? '日本酒' : category === 'snack' ? 'ふるさと納税' : '卓上家電'}", "家飲み", "本音比較", "飲み比べ"]
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
        article.contentHtml = convertToCleanHtml(article.contentHtml);
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
        article.contentHtml = convertToCleanHtml(article.contentHtml);
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
  console.log('[エディタ] CKEditor / テキストエリアへの注入を試行中...');
  
  // 1. CKEditor 経由
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

  // 2. iframe (WYSIWYG) 経由
  const iframeResult = await page.evaluate((html) => {
    const iframe = document.querySelector('iframe.cke_wysiwyg_frame, iframe[title*="エディタ"]');
    if (iframe && iframe.contentDocument) {
      iframe.contentDocument.body.innerHTML = html;
      return true;
    }
    return false;
  }, fullHtml).catch(() => false);

  if (iframeResult) {
    console.log(`[エディタ] iframe innerHTML 注入 成功`);
    await page.waitForTimeout(1000);
    return true;
  }

  // 3. 通常のtextarea / hidden input 経由
  const textareaResult = await page.evaluate((html) => {
    const area = document.querySelector('textarea[name="entry_text"], #entryText, textarea.js-editor-textarea');
    if (area) {
      area.value = html;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      area.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }, fullHtml).catch(() => false);

  if (textareaResult) {
    console.log(`[エディタ] textarea 注入 成功`);
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

  // 確実に完全なHTML（<h2>, <h3>, <hr>, <strong>, <p>など）に変換
  const fullHtml = convertToCleanHtml(cleanContent);

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
  const randomObj = selectRandomKeyword();
  const randomKeyword = typeof randomObj === 'object' ? randomObj.keyword : randomObj;

  console.log(`検索キーワード: 「${randomKeyword}」 (カテゴリ: ${randomObj.category || 'appliance'})`);
  const itemPair = await fetchRakutenItemPair(randomObj);

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
