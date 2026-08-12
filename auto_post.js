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

// 1. 楽天APIから2つのメイン商品情報（比較用）を取得
// 統一ルール:
// 【パターン1】別ジャンル卓上調理家電同士の対決（例: 卓上燻製機 vs 卓上調理ポット）
// 【パターン2】同ジャンルで「異なるブランド」同士の対決（例: ブランドAの燻製機 vs ブランドBの燻製機）
async function fetchRakutenItemPair(primaryKeyword) {
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

  // 50% の確率で「異ジャンル比較」、50% の確率で「同ジャンル別ブランド比較」を実行
  const useCrossGenre = Math.random() < 0.5;

  let itemA = null;
  let itemB = null;

  if (useCrossGenre) {
    console.log(`[比較対決モード] 【パターン1】異ジャンル対決モード`);
    // 別のジャンルキーワードを選択
    const secondaryKeyword = selectRandomKeyword([primaryKeyword]);
    
    const itemsA = (await searchRakuten(primaryKeyword)).filter(i => !postedList.includes(i.Item.affiliateUrl || i.Item.itemUrl));
    const itemsB = (await searchRakuten(secondaryKeyword)).filter(i => !postedList.includes(i.Item.affiliateUrl || i.Item.itemUrl));

    if (itemsA.length > 0 && itemsB.length > 0) {
      itemA = itemsA[Math.floor(Math.random() * itemsA.length)].Item;
      itemB = itemsB[Math.floor(Math.random() * itemsB.length)].Item;
    }
  }

  // 異ジャンル比較で取得できなかった場合、または同ジャンル別ブランド比較モードの場合
  if (!itemA || !itemB) {
    console.log(`[比較対決モード] 【パターン2】同ジャンル・異ブランド対決モード (${primaryKeyword})`);
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
      // 件数が足りない場合、フォールバックとしてサブキーワードから補填
      const secondaryKeyword = selectRandomKeyword([primaryKeyword]);
      const itemsA = await searchRakuten(primaryKeyword);
      const itemsB = await searchRakuten(secondaryKeyword);
      if (itemsA.length > 0 && itemsB.length > 0) {
        itemA = itemsA[0].Item;
        itemB = itemsB[0].Item;
      }
    }
  }

  if (!itemA || !itemB) return null;

  // 投稿済みリストに保存
  savePostedItem(itemA.affiliateUrl || itemA.itemUrl);
  savePostedItem(itemB.affiliateUrl || itemB.itemUrl);

  console.log(`[比較対決設定確定] 商品A: ${cleanProductName(itemA.itemName)} VS 商品B: ${cleanProductName(itemB.itemName)}`);

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
  if (rand < 0.33) {
    // 卓上調理家電（33%）
    keywordPool = TABLETOP_APPLIANCE_KEYWORDS;
  } else if (rand < 0.66) {
    // ふるさと納税お菓子（33%）：甘いもの同士50% / 塩っぽいもの同士50%
    keywordPool = Math.random() < 0.5 ? SWEET_SNACK_KEYWORDS : SAVORY_SNACK_KEYWORDS;
  } else {
    // 本格お酒銘柄（34%）：日本酒、ウイスキー、ワインから選出
    const liquorRand = Math.random();
    if (liquorRand < 0.34) keywordPool = SAKE_KEYWORDS;
    else if (liquorRand < 0.67) keywordPool = WHISKY_KEYWORDS;
    else keywordPool = WINE_KEYWORDS;
  }

  const available = keywordPool.filter(k => !usedKeywords.includes(k) && !excludeList.includes(k));
  const pool = available.length > 0 ? available : keywordPool.filter(k => !excludeList.includes(k));
  const chosen = pool[Math.floor(Math.random() * pool.length)] || keywordPool[0];
  saveUsedKeyword(chosen);
  return chosen;
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

  // 【パターン群 A】家電の機能・生活スタイル視点（15パターン）
  const PATTERNS_APPLIANCE = [
    { titleTemplate: `『${nameA}』と『${nameB}』、買うならどっち？`, introIdea: `夜って、なんとなく楽天とかAmazonを眺めちゃうことありません？\n\n別に今すぐ何かが欲しいわけでもないんだけど...`, h2_a: `## ${nameA}、なんか色々できる`, h2_b: `## でも「家でおつまみ焼きながら飲む」なら、${nameB}の方が気になる`, h2_diff: `## 約${priceDiff}円の差、どう考える？`, h2_eval: `## で、結局どっちがいいんだろう`, summaryHeadline: `## ちなみに、こういう比較って結局「生活」で決めるのが一番早い` },
    { titleTemplate: `家飲みをちょっと贅沢にするなら『${nameA}』と『${nameB}』どっちが正解？`, introIdea: `仕事終わりとか休日前の夜って、ちょっと家飲みを充実させたくなるんですよね。\n\n居酒屋に行くほどじゃないけど、家で美味しいもの食べたいな、みたいな。`, h2_a: `## 多機能で料理の幅が広がりそうな、${nameA}`, h2_b: `## 一方で、目の前で焼くライブ感がたまらない${nameB}`, h2_diff: `## 価格差は約${priceDiff}円。この差をどう捉えるか`, h2_eval: `## 自分の使い道に合うのはどちらか`, summaryHeadline: `## 結局のところ、「どんな夜を過ごしたいか」で選ぶのが正解かも` },
    { titleTemplate: `【本音】『${nameA}』と『${nameB}』で迷った結果...自分の生活に合うのはどっち？`, introIdea: `卓上家電をいろいろ見ていたら、気になる2台を見つけちゃいました。\n\n片方は色々できて機能的、もう片方はシンプルだけど家飲みが絶対楽しくなるやつ。`, h2_a: `## これ一台で何でもこなせる${nameA}の万能さ`, h2_b: `## でも、お酒のおつまみ特化なら${nameB}も捨てがたい`, h2_diff: `## 約${priceDiff}円の値段の差。自分にとって必要なのは？`, h2_eval: `## 実際に使う場面を想像してみる`, summaryHeadline: `## 迷ったら「自分が普段どんな風にお酒を飲んでいるか」を思い出す` },
    { titleTemplate: `一人飲みの相棒にするなら『${nameA}』と『${nameB}』、どっちが快適？`, introIdea: `一人でお酒を飲んでいる時って、手軽に温かいおつまみが欲しくなるんですよね。\n\nサクッと準備できて、後片付けもラクなのが一番。`, h2_a: `## 普段の料理からお惣菜の温め直しまで使える${nameA}`, h2_b: `## 一方、卓上にポンと置いて呑み続けられる${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。手軽さにどこまで投資するか`, h2_eval: `## 準備と片付けの手間を比べてみる`, summaryHeadline: `## 結論：「手軽さ重視」か「家飲みの雰囲気重視」かで決めると失敗しない` },
    { titleTemplate: `『${nameA}』と『${nameB}』、買って後悔しないのはどっち？【生活感リアル比較】`, introIdea: `家電を買う時って、「買ったはいいけど結局使わなくなるんじゃないか」って不安になりません？\n\nだからこそ、自分のズボラ度と相談して決めたいところ。`, h2_a: `## 出しっぱなしで毎日活躍しそうな${nameA}`, h2_b: `## 週末の「居酒屋気分」を最高にしてくれる${nameB}`, h2_diff: `## 約${priceDiff}円の差額。使用頻度で考えてみる`, h2_eval: `## 結局、どっちが長続きしそうか`, summaryHeadline: `## 迷ったら「普段の自分が一番テンション上がる場面」で選んでOK` },
    { titleTemplate: `外飲みを減らして『${nameA}』か『${nameB}』を導入したら、家飲みが最高になった話`, introIdea: `最近、外で飲むよりも「家でまったり飲む」方が落ち着くな〜と思うことが増えました。\n\nそれなら、おつまみを美味しくする家電にちょっと投資するのもアリかなと。`, h2_a: `## 本格的な調理からおつまみまで万能にこなす${nameA}`, h2_b: `## まさに「家飲み専用マシン」として活躍する${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。外飲み何回分かで考えると？`, h2_eval: `## 家飲みの質が上がるのはどっちか`, summaryHeadline: `## 自分の「家飲みの満足度」が一番上がる方を選ぶのが一番得` },
    { titleTemplate: `置き場所と使い勝手で比べる『${nameA}』VS『${nameB}』のリアル`, introIdea: `卓上家電を買う時に、地味に一番大事なのって「どこに置くか」なんですよね。\n\n置きっぱなしにするのか、飲む時だけサッと出すのか。`, h2_a: `## キッチンに常設して毎日の料理にも使える${nameA}`, h2_b: `## リビングのテーブルに移動させてすぐ使える${nameB}`, h2_diff: `## 約${priceDiff}円の価格差と、収納のしやすさ`, h2_eval: `## 自分のキッチンスペースと生活動線で考える`, summaryHeadline: `## 家電選びは「どこでどう使うか」のイメージが湧いた方が勝ち` },
    { titleTemplate: `【ふと気になった】『${nameA}』と『${nameB}』、直感で欲しいのはどっち？`, introIdea: `ネットサーフィンをしていて「お、これいいな」って直感で目についた2つ。\n\n見れば見るほど両方魅力的で、それぞれの良さがあるんですよね。`, h2_a: `## デザインも機能も欲張りたくなる${nameA}`, h2_b: `## シンプルゆえに「こういうのでいいんだよ」感がある${nameB}`, h2_diff: `## 約${priceDiff}円の差。直感で選ぶか、実用性で選ぶか`, h2_eval: `## 自分の直感と本音に向き合ってみる`, summaryHeadline: `## 結局、見ていて一番ワクワクする方が一番の正解かも` },
    { titleTemplate: `買ってきたお惣菜を激ウマにするなら『${nameA}』と『${nameB}』どっちが良い？`, introIdea: `夜にスーパーでお惣菜買ってきて飲むことって多いんですよね。\n\nそのまま食べるより、温め直したり卓上で一手間加えるだけで美味しさが全然違う。`, h2_a: `## お惣菜の温め直しやノンフライ調理が得意な${nameA}`, h2_b: `## 目の前で炙ったり焼いたりして味わう${nameB}`, h2_diff: `## 約${priceDiff}円の差。手軽さと香ばしさのどちらを取る？`, h2_eval: `## 普段買ってくるおつまみとの相性で比べる`, summaryHeadline: `## 「普段スーパーで何を買って飲むか」で選ぶと失敗しない` },
    { titleTemplate: `食卓の楽しさが変わる！『${nameA}』と『${nameB}』のリアルな活躍シーン比較`, introIdea: `家でお酒を飲む時間って、一人で静かに飲む日もあれば、誰かと話しながら飲む日もありますよね。\n\nどんなシチュエーションで一番使いたいかを考えてみました。`, h2_a: `## 朝食から夕食・晩酌まで幅広くカバーする${nameA}`, h2_b: `## テーブルの真ん中に置いて居酒屋気分を味わえる${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。使用頻度と楽しさのバランス`, h2_eval: `## 自分の食卓のスタイルに合わせて考える`, summaryHeadline: `## 自分のライフスタイルにすんなり溶け込む方を選ぶのが一番` },
    { titleTemplate: `【ズボラ目線】使った後の洗やすさで選ぶなら『${nameA}』と『${nameB}』どっち？`, introIdea: `家飲み家電を買う時に、どうしても頭をよぎるのが「使った後の片付け」です。\n\n酔っ払った後に面倒な洗物をするのは嫌ですもんね。`, h2_a: `## パーツが外せてお手入れしやすい構造の${nameA}`, h2_b: `## 構造がシンプルで洗い物が少なくて済む${nameB}`, h2_diff: `## 約${priceDiff}円の差。手入れの楽さと機能性の比較`, h2_eval: `## 飲んだ後の片付けの心理的ハードルで比べる`, summaryHeadline: `## 「使った後に億劫にならないか」を基準に選ぶのもかなり大事` },
    { titleTemplate: `おうち居酒屋を開店するなら『${nameA}』と『${nameB}』どちらを指名する？`, introIdea: `美味しいお酒と熱々のおつまみがあるだけで、家飲みの満足度って一気に跳ね上がりますよね。\n\n家で手軽におうち居酒屋感を楽しめる2台を比べてみました。`, h2_a: `## 一台で何種類ものおつまみ料理に対応できる${nameA}`, h2_b: `## 焼きたてアツアツをその場でつまめる${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。おうち居酒屋のクオリティ差`, h2_eval: `## どんなおつまみでお酒を飲みたいか`, summaryHeadline: `## 「呑みたいお酒と食べたいおつまみ」を想像して決めるのが一番楽しい` },
    { titleTemplate: `『${nameA}』か『${nameB}』か、物欲を刺激された2台を徹底解剖`, introIdea: `夜中ってついついネット通販の特集ページを読み込んじゃいます。\n\n「これあったら絶対家飲み楽しいよな」と思える2台があったのでメモ。`, h2_a: `## 調理家電としてのスペックも十分高い${nameA}`, h2_b: `## 卓上で焼くというロマンに特化した${nameB}`, h2_diff: `## 約${priceDiff}円の差。スペック重視かロマン重視か`, h2_eval: `## 自分の心が躍るのはどちらか`, summaryHeadline: `## 「物欲に素直になる」のも買い物の醍醐味かも` },
    { titleTemplate: `長続きするのはどっち？『${nameA}』と『${nameB}』の出番の多さ比較`, introIdea: `せっかく買うならタンスの肥やしにしたくないですよね。\n\n1ヶ月後もちゃんと使っているイメージが湧くのはどっちか考えました。`, h2_a: `## 毎日の朝食や夕食のサポートにも回れる${nameA}`, h2_b: `## 週末の晩酌セットとして確固たる地位を築く${nameB}`, h2_diff: `## 約${priceDiff}円の価格差と実用性の天秤`, h2_eval: `## 自分の生活サイクルへの馴染みやすさ`, summaryHeadline: `## 「週に何回出すか」を想像してみるのがおすすめ` },
    { titleTemplate: `【本音レビュー】『${nameA}』と『${nameB}』、自分のキッチンの主役になるのは？`, introIdea: `新しく家電を迎え入れる時のあのワクワク感。\n\n自分のキッチンやテーブルの雰囲気に合うのはどっちか探ってみました。`, h2_a: `## 見た目もおしゃれでインテリアに馴染む${nameA}`, h2_b: `## 昔ながらの居酒屋風の渋い存在感がある${nameB}`, h2_diff: `## 約${priceDiff}円の差。デザインと存在感の比較`, h2_eval: `## 自分の部屋に置いた時の馴染み具合`, summaryHeadline: `## 見た目の愛着も含めて選ぶのが失敗しない秘訣` }
  ];

  // 【パターン群 B】お酒・酒の肴・アテの相性に特化（15パターン）
  const PATTERNS_LIQUOR = [
    { titleTemplate: `キンキンに冷えたビールに合わせるなら『${nameA}』と『${nameB}』どっちが最強？`, introIdea: `仕事終わりの一杯、冷えたビールを喉に流し込む瞬間って最高ですよね。\n\nそんなビールに一番合うアツアツのおつまみを作るなら、どちらが優秀か真剣に考えてみました。`, h2_a: `## 揚げ物や香ばしい料理でビールが進む${nameA}`, h2_b: `## 焼き鳥や香ばしい網焼きでビールが進む${nameB}`, h2_diff: `## 価格差約${priceDiff}円。ビールの相棒として投資する価値は？`, h2_eval: `## ビール党の自分が選ぶならどっちか`, summaryHeadline: `## 結論：「ガッツリおつまみ」か「香ばしい焼き系アテ」かで決まる` },
    { titleTemplate: `ハイボールのアテを作るなら『${nameA}』と『${nameB}』、どっちが至高？`, introIdea: `シュワっと爽快なハイボールを飲む夜って、ちょっと脂のある旨いおつまみが欲しくなります。\n\nハイボールの美味しさを引き立てるアテを作るならどっちが良いか比べてみました。`, h2_a: `## カラッと揚げたて・サクサクおつまみを作れる${nameA}`, h2_b: `## 余分な脂を落としながらじっくり焼ける${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。ハイボール好きの目線で考える`, h2_eval: `## ハイボールが進むおつまみはどちらで作れるか`, summaryHeadline: `## 「サクサク感」か「ジューシーな香ばしさ」かで選ぶのが正解` },
    { titleTemplate: `日本酒をしっぽり呑むなら『${nameA}』と『${nameB}』どちらが引き立て役になる？`, introIdea: `静かな夜、お気に入りの日本酒をちびちび呑む時間って至福ですよね。\n\n日本酒の旨味を引き立てる絶品のおつまみを用意するならどっちが良いか探ってみました。`, h2_a: `## 素材の旨味を閉じ込めた焼き料理ができる${nameA}`, h2_b: `## 炙り魚や焼き鳥など最高のアテを目の前で焼ける${nameB}`, h2_diff: `## 価格差は約${priceDiff}円。日本酒のお供としての満足度`, h2_eval: `## ちびちび呑む夜に寄り添ってくれるのはどっちか`, summaryHeadline: `## じっくり味わいたいお酒だからこそ、アテの焼き上がりにこだわりたい` },
    { titleTemplate: `レモンサワーに合う旨いおつまみ対決！『${nameA}』VS『${nameB}』`, introIdea: `爽やかなレモンサワーを飲みながら、卓上で温かいものを突くのって最高に楽しいですよね。\n\nサワー系のお酒にベストマッチするおつまみを作れるのはどちらか比較しました。`, h2_a: `## 濃いめのおつまみやお惣菜をカリッと仕上げる${nameA}`, h2_b: `## 焼きたての塩焼きやタレ焼きを楽しめる${nameB}`, h2_diff: `## 約${priceDiff}円の差。普段のサワータイムがどう変わるか`, h2_eval: `## 卓上で作れるおつまみの幅を比較`, summaryHeadline: `## 毎週末のサワータイムが一番ワクワクする方を選ぶのが一番` },
    { titleTemplate: `ワインやクラフトビールのお供に！『${nameA}』と『${nameB}』はどっちがおしゃれ？`, introIdea: `週末の夜、ちょっと良いワインやクラフトビールを開ける日ってありますよね。\n\nそんなワンランク上の家飲みに合うアテを用意するならどっちが似合うか考えてみました。`, h2_a: `## グリル料理やオーブン料理もお手の物の${nameA}`, h2_b: `## 卓上で素材をそのまま炙って愉しめる${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。家飲みの雰囲気を重視するなら`, h2_eval: `## 洋酒やクラフトビールとの相性をチェック`, summaryHeadline: `## 「料理のオシャレさ」か「素材そのものの美味しさ」かで選ぶ` },
    { titleTemplate: `焼酎のロックや水割りが進むアテなら『${nameA}』と『${nameB}』どっちが優勝？`, introIdea: `香ばしい焼酎を飲みながら、じっくり旨いものを食べる時間って落ち着きますよね。\n\n焼酎好きに刺さる最高のおつまみ環境を作れるのはどちらか本音で比べました。`, h2_a: `## 多彩なおつまみレシピに対応できる万能さを持つ${nameA}`, h2_b: `## 香ばしい煙と香りで酒が進む本格ロースター${nameB}`, h2_diff: `## 約${priceDiff}円の値段の差。焼酎のお供としてのコスパ`, h2_eval: `## 焼酎が進むのはどっちのアテか`, summaryHeadline: `## 自分の好きな焼酎のアテを想像して選ぶと間違いなし` },
    { titleTemplate: `【乾杯のお供】『${nameA}』と『${nameB}』、最初に作って呑みたいおつまみ対決`, introIdea: `「よし、飲むぞ！」となった瞬間、最初に用意したい熱々のおつまみ。\n\nその最初の乾杯を一番最高にしてくれるのはどちらの家電か想像してみました。`, h2_a: `## 買ってきた惣菜も一瞬で絶品おつまみに変える${nameA}`, h2_b: `## 網の上でじわじわ焼けるのを待つ時間も呑める${nameB}`, h2_diff: `## 約${priceDiff}円の差。呑み始めのテンションを左右するのは？`, h2_eval: `## 乾杯の一杯目が一番美味しくなるのはどっちか`, summaryHeadline: `## 「すぐ食べたい派」か「焼ける過程も楽しみたい派」かで決まる` },
    { titleTemplate: `深夜のコソ呑み・夜食おつまみに適しているのは『${nameA}』か『${nameB}』か？`, introIdea: `夜深くなった時間に、静かにお酒とおつまみを楽しむコソ呑みタイム。\n\n近所迷惑や匂いを気にしつつ、最高のアテを作るならどっちが良いか比べました。`, h2_a: `## 匂いや煙を抑えつつサクッと調理できる${nameA}`, h2_b: `## 卓上で手軽に一人前のおつまみを焼き上げられる${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。深夜の手軽さと気兼ねなさ`, h2_eval: `## 夜中の呑み時間での使い勝手を検証`, summaryHeadline: `## 深夜にサクッと飲んで気分良く寝られる方を選ぶのが正解` },
    { titleTemplate: `【熱々つまみ】『${nameA}』と『${nameB}』、最後まで温かく呑めるのはどっち？`, introIdea: `おつまみって、冷めてしまうと一気に美味しさが半減しちゃいますよね。\n\nお酒を呑み終わる最後のひと口まで熱々を保てるのはどちらか比較しました。`, h2_a: `## 保温や再加熱が手軽でいつでも温かい${nameA}`, h2_b: `## 目の前の網の上でずっと温かいままキープできる${nameB}`, h2_diff: `## 約${priceDiff}円の差。熱々おつまみの持続性で考える`, h2_eval: `## ダラダラ長呑みする時の快適さを比較`, summaryHeadline: `## 「呑みながら常に熱々を食べたい」なら卓上焼き系が圧倒的` },
    { titleTemplate: `缶チューハイやハイボール缶を100倍美味しくする『${nameA}』VS『${nameB}』`, introIdea: `コンビニで缶チューハイを買って帰る普段の家飲み。\n\nそのいつもの缶チューハイを「居酒屋クオリティ」に変えてくれるのはどっちか考えました。`, h2_a: `## 居酒屋風の揚げ物やグリルが家で再現できる${nameA}`, h2_b: `## 目の前で焼く炭火焼き風のおつまみが味わえる${nameB}`, h2_diff: `## 約${priceDiff}円の差。普段の缶チューハイライフの格上げ度`, h2_eval: `## いつものお酒が格段に美味しくなるのはどっちか`, summaryHeadline: `## 普段呑んでいる缶チューハイの満足度で決めるのが一番` },
    { titleTemplate: `【珍味・干物・焼き鳥】『${nameA}』と『${nameB}』で絶品酒の肴対決！`, introIdea: `エイヒレや干物、焼き鳥など、酒乗り抜群の渋い珍味やおつまみ。\n\nそういった酒の肴を一番美味しく調理できるのはどちらか本音で探りました。`, h2_a: `## 幅広い食材をふっくら香ばしく焼き上げる${nameA}`, h2_b: `## 干物や焼き鳥の脂を落としながら香ばしく炙る${nameB}`, h2_diff: `## 価格差は約${priceDiff}円。渋い珍味・アテとの相性`, h2_eval: `## 自分が大好きな酒の肴を美味しくできるのはどっちか`, summaryHeadline: `## 好きな「酒の肴」が一番生きる方を選ぶのが一番幸せ` },
    { titleTemplate: `休日の昼呑み・せんべろ気分を味わうなら『${nameA}』と『${nameB}』どっち？`, introIdea: `休日の明るい時間から、のんびりお酒を呑む「昼呑み」って最高に贅沢ですよね。\n\nそんな昼呑み・せんべろ気分を自宅で満喫するならどっちが良いか比べました。`, h2_a: `## ランチ兼おつまみまで幅広くカバーする${nameA}`, h2_b: `## まさに大衆酒場のような雰囲気を家で楽しめる${nameB}`, h2_diff: `## 約${priceDiff}円の差。休日のまったり呑みでの満足感`, h2_eval: `## 昼呑みのテンションが上がるのはどっちか`, summaryHeadline: `## 自分が理想とする「最高の休日呑み」の形で決めよう` },
    { titleTemplate: `熱燗やぬる燗に合う和風つまみ対決！『${nameA}』と『${nameB}』の旨さ`, introIdea: `肌寒い夜やホッとしたい時、温かいお酒を味わう時間。\n\nその熱燗のお供にぴったりなおつまみを準備するならどっちが良いか考えました。`, h2_a: `## 温かみのある和風グリル料理もこなす${nameA}`, h2_b: `## 炙りものや香ばしい魚を目の前で焼く${nameB}`, h2_diff: `## 約${priceDiff}円の差。和風のおつまみ適性で比べる`, h2_eval: `## 燗酒の旨味を引き立てるのはどっちか`, summaryHeadline: `## 温かいお酒を呑む夜の最高の相棒を見つけよう` },
    { titleTemplate: `ウイスキーのロックや水割りに合う至高のアテ『${nameA}』VS『${nameB}』`, introIdea: `ウイスキーをグラスに注ぎ、ゆっくり芳醇な香りを愉しむ大人の夜。\n\nその時間をさらに上質なものにしてくれるアテはどちらで作れるか検証。`, h2_a: `## 燻製風味や香ばしいロースト系が得意な${nameA}`, h2_b: `## じっくり炙った肉やチーズなどを楽しめる${nameB}`, h2_diff: `## 約${priceDiff}円の値段の差。ウイスキーのお供としての格`, h2_eval: `## 濃厚なお酒と引き立て合うアテはどちらか`, summaryHeadline: `## ゆっくり味わうお酒にはそれ相応の熱々アテが一番` },
    { titleTemplate: `サワー・果実酒を呑みながらつまみたい！『${nameA}』と『${nameB}』の使い勝手`, introIdea: `フルーティーな果実酒やサワーを片手に、リビングでまったり過ごす週末。\n\n手軽に突ける美味しいおつまみを用意するならどちらが便利か比べました。`, h2_a: `## 惣菜の温め直しやサクサク食感を作る${nameA}`, h2_b: `## 卓上で少量ずつ焼いてつまみ続けられる${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。カジュアルな家呑みでの相性`, h2_eval: `## サワーが進むおつまみ環境の比較`, summaryHeadline: `## 気軽に呑めるお酒だからこそおつまみ準備も手軽に` }
  ];

  // 【パターン群 C】テーマ別・シチュエーション・心理比較（20パターン）
  const PATTERNS_THEMED = [
    { titleTemplate: `【夜中の物欲】『${nameA}』と『${nameB}』、カゴに入れたくなるのはどっち？`, introIdea: `夜中になんとなくネット通販を見ていて「お、これいいじゃん」ってカートに入れそうになる瞬間。\n\n結局どっちを決済したら満足度が高いかシミュレーション。`, h2_a: `## 機能性抜群で買って損しなさそうな${nameA}`, h2_b: `## 届いた日の夜の家飲みが楽しみになる${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。決済の決断を分けるポイント`, h2_eval: `## カートに入れた時のワクワク感を比較`, summaryHeadline: `## 自分の直感が「買ってよかった」と思える方を選ぼう` },
    { titleTemplate: `卓上家電で後悔したくない！『${nameA}』と『${nameB}』の失敗しない選び方`, introIdea: `せっかく買ったのに数回使って押し入れ行き...ということだけは避けたいですよね。\n\n自分の性格や生活習慣に照らし合わせて、本当に使う方を考えてみました。`, h2_a: `## 普段の料理や食事でも活躍の場が多い${nameA}`, h2_b: `## 「呑む」という目的に特化して満足度が高い${nameB}`, h2_diff: `## 約${priceDiff}円の差。タンスの肥やしにしないための判断基準`, h2_eval: `## 自分の性格上、どちらが長続きするか`, summaryHeadline: `## 迷ったら「普段の自分のズボラさ」に合わせるのが鉄則` },
    { titleTemplate: `『${nameA}』と『${nameB}』、我が家の食卓に馴染むのはどっちだ？`, introIdea: `家電って性能も大事だけど、食卓やリビングに置いた時の「馴染み具合」も大事。\n\n自分の家のテーブルに置いた時のリアルな使用風景を想像しました。`, h2_a: `## すっきりしたデザインで常設しやすい${nameA}`, h2_b: `## 卓上に置くだけで屋台や居酒屋の雰囲気が出る${nameB}`, h2_diff: `## 約${priceDiff}円の差。生活空間との調和で考える`, h2_eval: `## 自分の部屋や食卓との相性をチェック`, summaryHeadline: `## テーブルに置いた時の「しっくり感」で選ぶと愛着が湧く` },
    { titleTemplate: `【時短・お手軽】仕事終わりのヘトヘトな夜に救世主となるのは『${nameA}』か『${nameB}』か`, introIdea: `仕事で疲れて帰ってきた夜。「美味しいものは食べたいけど凝った料理は無理」という日。\n\nそんなヘトヘトな夜に一番癒しをくれるのはどっちか本音比較。`, h2_a: `## 放り込むだけ・温め直すだけで完成する${nameA}`, h2_b: `## 網に食材を並べるだけで居酒屋気分になれる${nameB}`, h2_diff: `## 約${priceDiff}円の差。疲れた夜の手軽さへの投資`, h2_eval: `## 疲れている時でも使う気になるのはどっちか`, summaryHeadline: `## 疲れた自分を一番甘やかしてくれる方を選ぼう` },
    { titleTemplate: `休日のまったりタイムを格上げ！『${nameA}』と『${nameB}』の贅沢度比較`, introIdea: `休日の夕方から、好きな映画や動画を見ながらだらだらお酒を飲む時間。\n\nその最高の休日タイムをより贅沢にしてくれるのはどっちか探ってみました。`, h2_a: `## クオリティの高い料理をお供に呑める${nameA}`, h2_b: `## 自分のペースで焼きながらのんびり呑める${nameB}`, h2_diff: `## 約${priceDiff}円の差。休日の充実度の上がり幅`, h2_eval: `## 休日のおうち時間を格上げしてくれるのはどちらか`, summaryHeadline: `## 「どんな休日の過ごし方が好きか」で答えは自ずと出る` },
    { titleTemplate: `『${nameA}』VS『${nameB}』！お惣菜派と手作り派、どちらに響く？`, introIdea: `家飲みのおつまみって、スーパーのお惣菜を頼る派と、軽く手作りする派に分かれますよね。\n\n自分のスタイルに合っているのはどちらか比較しました。`, h2_a: `## スーパーのお惣菜をワンランク上の味にする${nameA}`, h2_b: `## シンプルな食材を焼くだけでご馳走にする${nameB}`, h2_diff: `## 約${priceDiff}円の差。おつまみ準備のスタイル比較`, h2_eval: `## 普段の自分のおつまみ調達方法に合うのは`, summaryHeadline: `## 普段のおつまみの買い方に合わせるのが一番自然` },
    { titleTemplate: `【ミニマリスト vs ロマン派】『${nameA}』と『${nameB}』の思想の違い`, introIdea: `1台で何役もこなす多機能なモノと、1つの目的に特化した浪漫あふれるモノ。\n\n自分の物選びの基準にヒットするのはどっちか考察してみました。`, h2_a: `## 省スペースで多様な調理をこなすミニマムさ${nameA}`, h2_b: `## 「卓上で焼く」という体験に特化したロマン${nameB}`, h2_diff: `## 約${priceDiff}円の差。物選びの価値観で比べる`, h2_eval: `## 自分の所有欲を満たしてくれるのはどっちか`, summaryHeadline: `## 実用性を取るか、趣味性を取るかで決めよう` },
    { titleTemplate: `一人呑みでの使い勝手『${nameA}』と『${nameB}』のリアルな距離感`, introIdea: `一人で呑んでいる時って、家電のサイズ感や取り回しの良さがすごく気になります。\n\n自分の手元に置いた時のしっくり感を比べてみました。`, h2_a: `## 手軽にサッと使えて片付けもスムーズ${nameA}`, h2_b: `## 手元で焼きながらちびちび呑むのに最適${nameB}`, h2_diff: `## 約${priceDiff}円の差。一人呑みでのパーソナル感`, h2_eval: `## 一人呑みの相棒としてしっくり来るのは`, summaryHeadline: `## 一人で気兼ねなく使えるサイズ感と手軽さが一番` },
    { titleTemplate: `『${nameA}』と『${nameB}』、友達やパートナーが来た時に盛り上がるのは？`, introIdea: `普段は一人で呑んでいても、たまに人が遊びに来て一緒に呑むこともありますよね。\n\nそんな「誰かと呑む日」にも活躍するのはどちらか想像。`, h2_a: `## いろんな料理を出してもてなせる${nameA}`, h2_b: `## 目の前で焼いてイベント感を楽しめる${nameB}`, h2_diff: `## 約${priceDiff}円の差。エンタメ性ともてなし力の比較`, h2_eval: `## 人と一緒に呑む時の盛り上がり度`, summaryHeadline: `## テーブルの上が盛り上がるシーンをイメージしてみよう` },
    { titleTemplate: `【煙・匂い・お手入れ】生活感全開で較べる『${nameA}』VS『${nameB}』`, introIdea: `部屋に匂いが残らないか、油跳ねはどうなるか、使った後の洗浄は楽か。\n\nリアルな生活目線で一番ストレスなく使えるのはどっちか検証。`, h2_a: `## 密閉性や使い勝手で汚れや匂いを抑えやすい${nameA}`, h2_b: `## 卓上焼き特有の煙や油対策を工夫して使う${nameB}`, h2_diff: `## 約${priceDiff}円の差。快適さと手入れの手間の天秤`, h2_eval: `## 普段のお手入れのしやすさで比べる`, summaryHeadline: `## 部屋の環境とお手入れの手間で選ぶと後悔なし` },
    { titleTemplate: `『${nameA}』か『${nameB}』で迷った時、最後に背中を押す決め手とは？`, introIdea: `スペックも価格も確認して、どちらも魅力的で甲乙つけがたい時。\n\n最後の決め手となるポイントはどこにあるのか整理してみました。`, h2_a: `## 「普段使いの調理家電」としての汎用性${nameA}`, h2_b: `## 「家飲みを楽しくする専用ギア」としての魅力${nameB}`, h2_diff: `## 約${priceDiff}円の差。最後の一押しとなる要素`, h2_eval: `## 自分が今一番求めている体験はどっちか`, summaryHeadline: `## 自分の生活をどう変えたいかで最後は決めよう` },
    { titleTemplate: `【コスパ検証】約${priceDiff}円の価格差に見合う満足度は『${nameA}』と『${nameB}』どちらにある？`, introIdea: `買い物をする時、金額に見合った満足が得られるかが一番気になりますよね。\n\n22,000円と5,000円という価格差をどう評価すべきか考察。`, h2_a: `## 高機能で用途が広いため長く元が取れる${nameA}`, h2_b: `## 手頃な価格で家飲みの体験を劇的に変える${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。それぞれのコスパの高さ`, h2_eval: `## 満足度が高い買い物になるのはどちらか`, summaryHeadline: `## 金額以上の価値を感じられる方に投資するのが正解` },
    { titleTemplate: `『${nameA}』と『${nameB}』、自分の毎日のルーティンに組み込みやすいのは？`, introIdea: `生活習慣の中に自然と溶け込む家電は、買って満足して終わることがありません。\n\n自分の夜のルーティンに馴染むのはどっちかシミュレーション。`, h2_a: `## 夕食の準備から晩酌までスムーズに繋がる${nameA}`, h2_b: `## お酒を作るタイミングでサッと準備できる${nameB}`, h2_diff: `## 約${priceDiff}円の差。日常への溶け込みやすさ`, h2_eval: `## 自分の夜の過ごし方と親和性が高い方`, summaryHeadline: `## 無理なく日常に組み込める方を選ぶと長く愛用できる` },
    { titleTemplate: `【家飲み革命】『${nameA}』か『${nameB}』で、我が家の晩酌はどう変わる？`, introIdea: `新しい家電をひとつ導入するだけで、いつもの晩酌の風景ってガラリと変わります。\n\nどちらを導入した方がワクワクする変化が訪れるか想像してみました。`, h2_a: `## 料理の選択肢が増えて豊かな食卓になる${nameA}`, h2_b: `## 卓上が居酒屋カウンターのように変身する${nameB}`, h2_diff: `## 約${priceDiff}円の差。晩酌タイムの変革度`, h2_eval: `## 自分が味わいたいワクワク感はどっちか`, summaryHeadline: `## 思い描いた時に心が一番躍る方を選ぼう` },
    { titleTemplate: `『${nameA}』VS『${nameB}』！ズボラな自分でも使いこなせるのはどっち？`, introIdea: `自慢じゃないですが、私は根がズボラです。面倒な工程があるとすぐ使わなくなります。\n\nそんなズボラ目線で最後まで愛用できるのはどっちか本音で比較。`, h2_a: `## 操作がシンプルで失敗が少ない${nameA}`, h2_b: `## 焼くだけという極めて単純な工程で済む${nameB}`, h2_diff: `## 約${priceDiff}円の差。ズボラ度と使いやすさの比較`, h2_eval: `## ズボラな自分でも面倒にならないのは`, summaryHeadline: `## 自分のズボラさに優しく寄り添ってくれる方を選ぼう` },
    { titleTemplate: `【物欲の秋・冬・春】『${nameA}』と『${nameB}』でおうち呑み環境をアップデート`, introIdea: `季節の変わり目って、家呑みの環境を新しくしたくなりますよね。\n\n今、自分の部屋に迎え入れるならどちらが最適か比較しました。`, h2_a: `## オールシーズン様々な料理で活躍する${nameA}`, h2_b: `## 卓上で温かいおつまみを育てる楽しさがある${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。アップデートの満足感`, h2_eval: `## 今の自分の部屋に必要なアップデートは`, summaryHeadline: `## 今の気分に一番マッチする方を選んで楽しもう` },
    { titleTemplate: `『${nameA}』と『${nameB}』、迷っている時間が一番楽しい説`, introIdea: `あれこれ比較して「どっちにしようかな」と悩んでいる時間って実は一番楽しかったりします。\n\n両者の魅力を再整理して、自分の本音を探ってみました。`, h2_a: `## 知れば知るほど欲しくなる多機能さ${nameA}`, h2_b: `## 見れば見るほど欲しくなるシンプルさ${nameB}`, h2_diff: `## 約${priceDiff}円の差。悩む楽しさと選ぶ決め手`, h2_eval: `## 悩みぬいた末に選ぶべき一台は`, summaryHeadline: `## 悩む時間も含めて買い物を楽しむのが一番` },
    { titleTemplate: `【酒乗りの良さ】『${nameA}』と『${nameB}』で作るおつまみ、お酒が進むのはどっち？`, introIdea: `おつまみで一番大事なのは「お酒が進むかどうか」。\n\n酒乗り抜群の絶品アテが作れるのはどちらか比較しました。`, h2_a: `## 凝った味付けやお惣菜のカリッと感で酒が進む${nameA}`, h2_b: `## 焼きたての香ばしさと香りで酒が進む${nameB}`, h2_diff: `## 約${priceDiff}円の価格差。酒乗りおつまみ作成能力`, h2_eval: `## 自分のお酒のペースが上がるのはどちらか`, summaryHeadline: `## お酒が一番美味しく感じる方を選ぶのが酒飲みの正解` },
    { titleTemplate: `『${nameA}』と『${nameB}』、自分の「おうち飲みスタイル」にハマるのは？`, introIdea: `人によって「理想のおうち飲みスタイル」って違いますよね。\n\n自分の目指す呑みスタイルにピタリとハマるのはどっちか探りました。`, h2_a: `## 料理もおつまみも完璧にこなすスタイリッシュ型${nameA}`, h2_b: `## 目の前でアテを焼きながら呑む居酒屋型${nameB}`, h2_diff: `## 約${priceDiff}円の差。スタイルの違いで選ぶ`, h2_eval: `## 自分が憧れる家呑みスタイルはどっちか`, summaryHeadline: `## 自分の理想の呑みスタイルに素直になろう` },
    { titleTemplate: `【まとめ比較】『${nameA}』と『${nameB}』、結局最後は「〇〇」で決める！`, introIdea: `長々と比較してきましたが、選択の基準は実はすごくシンプル。\n\n最後に自分自身の本音を引き出すための比較まとめ。`, h2_a: `## 料理の幅と汎用性を重視するなら${nameA}`, h2_b: `## 家飲みの楽しさと香ばしさを重視するなら${nameB}`, h2_diff: `## 約${priceDiff}円の価格差と得られる価値`, h2_eval: `## 自分が一番大切にしたい基準`, summaryHeadline: `## 「何のために買うか」の目的がはっきりすれば答えはすぐ出る` }
  ];

  // 全50パターン（家電視点15個 ＋ お酒アテ視点15個 ＋ テーマ視点20個）から完全ランダム選定
  const ALL_PATTERNS = [...PATTERNS_APPLIANCE, ...PATTERNS_LIQUOR, ...PATTERNS_THEMED];
  const pattern = ALL_PATTERNS[Math.floor(Math.random() * ALL_PATTERNS.length)];

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
   - 重複した単語（例：「お煎餅 お煎餅」など）は不自然なので絶対に書かないでください！

2. **タイトル**:
   - 必ず以下の指定タイトルテンプレートをそのまま出力してください。
   - タイトル: 「${pattern.titleTemplate}」

3. **文章スタンス・語り口・改行**:
   - **基本スタンス**: すべての記事において「自分で気になった商品を詳しく調べてはみたけど、どっちにするか決められないなー、どっちを次に買ってみようかなーと悩んでる」という個人ブログのリアルな空気感を徹底してください。
   - **アピール・押し売り禁止**: 「おすすめです！」「買いましょう！」などの言葉は絶対に使用禁止。売ろうとせず、純粋に迷ってください。
   - **お酒（日本酒・ウイスキー・ワイン等の銘柄比較）の場合**: 「最近お酒を色々と飲み比べてみたいなーって思ってるんですよね。じっくり味わえる本格的なお酒（銘柄）を開拓したくて。でも美味しそうな銘柄が多すぎてどれから手をつけるべきか選べない...」といったニュアンスの空気感で始めて真剣に悩んでください。
   - **ふるさと納税お菓子の場合**: 「ハイボール（やビール）を飲む時って、チョコやお煎餅のおつまみが欲しくなる。でもコンビニだと高いし...と思ったら楽天のふるさと納税で注文できると知って罪悪感ゼロで買えそう！でも美味しそうなものが多すぎてどちらにするか選べない...」というニュアンスの空気感を出してください。
   - **卓上調理家電の場合**: 「面白そうで便利そうな一人家飲み用（卓上用）のアイテムを見つけて、真剣に買おうか悩んでいる」という空気感を出してください。
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
   - \`## 実際に使う・食べるシーンをリアルに想像してみる\`
   - \`---\`
   - \`## 後片付けや保存の手間はどうだろう\`
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
以下のJSON形式のみで出力してください（Markdown表記の文字列としてcontentHtmlを出力）：
{
  "title": "${pattern.titleTemplate}",
  "contentHtml": "（指定された導入・見出し構成に沿ったMarkdown文章）",
  "tags": ["ふるさと納税", "おつまみ", "家飲み", "本音比較", "卓上家電"]
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
  const randomKeyword = selectRandomKeyword();

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
