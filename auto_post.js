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

// 投稿済み商品の識別情報（JANコード, itemCode, URL, クリーン商品名）を保存・読み込みする関数（永久重複防止）
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

function getItemIdentifiers(item) {
  if (!item) return [];
  const ids = [];
  if (item.janCode) ids.push(`JAN:${item.janCode}`);
  if (item.itemCode) ids.push(`CODE:${item.itemCode}`);
  if (item.affiliateUrl) ids.push(`URL:${item.affiliateUrl}`);
  if (item.itemUrl) ids.push(`URL:${item.itemUrl}`);
  if (item.cleanName) ids.push(`NAME:${item.cleanName}`);
  return ids;
}

function isItemAlreadyPosted(item, postedList) {
  if (!item || !postedList || postedList.length === 0) return false;
  const ids = getItemIdentifiers(item);
  return ids.some(id => postedList.includes(id));
}

function savePostedItem(item) {
  const posted = getPostedItems();
  const ids = typeof item === 'object' ? getItemIdentifiers(item) : [`URL:${item}`];
  let updated = false;

  for (const id of ids) {
    if (!posted.includes(id)) {
      posted.push(id);
      updated = true;
    }
  }

  if (updated) {
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

// 単品商品のみを厳選し、セット・飲み比べ・食べ比べ・定期便・バリエーション選択（6,9,12個から選べる等）・付属品・業務用を徹底排除する判定関数
function isMainProduct(item) {
  const name = item.itemName;
  const price = item.itemPrice;

  // 1. バリエーション選択式（「選べる」「〇個から選べる」等）の正規表現チェック
  const selectRegexPatterns = [
    /(選べる|えらべる|選択可能|選択可|お選び|から選|より選|お好みで)/i,
    /\d+[\s,、・~/〜\-]*(?:個|本|種|缶|箱|袋|kg|g|サイズ|味|セット)[\s,、・~/〜\-]*\d+/i,
    /\d+(?:,\s*\d+)+(?:個|本|種|袋|缶|サイズ)/i,
    /(?:小分け|大容量|アソート|バラエティ)/i
  ];

  for (const regex of selectRegexPatterns) {
    if (regex.test(name)) return false;
  }

  // 2. NGキーワード（セット商品・定期便・複数本・ケース買い・付属品等の徹底排除）
  const ngKeywords = [
    'セット', 'まとめ買い', '飲み比べ', '食べ比べ', '詰め合わせ', 'アソート',
    '定期便', '定期購入', '定期コース', '選べる定期便',
    '2本', '3本', '4本', '5本', '6本', '12本', '24本', '本組', '本入', '缶入',
    '2個', '3個', '4個', '5個', '6個', '個入', '箱入', '2箱', '3箱',
    'バラエティ', 'セレクト', 'ギフトセット', 'パック', '箱買い', 'ケース販売', 'ケース買い', '1ケース', '2ケース',
    '化粧箱のみ', 'ギフト箱のみ', '専用箱のみ', '包装紙のみ', 'のしのみ',
    '【パーツ】', '【部品】', '交換用', 'ミニボトル', 'お試しミニ', 'ミニチュア',
    '業務用', '店舗用', '施設用', '大容量業務用',
    '空ボトル', '空瓶', 'グラスのみ', 'タンブラーのみ'
  ];

  for (const kw of ngKeywords) {
    if (name.includes(kw)) return false;
  }

  // 価格が安すぎる商品（送料別小袋や付属品の可能性）を排除（2,000円未満を除外）
  if (price < 2000) return false;

  return true;
}

// 長すぎる型番やSEOキーワード・重複単語を除去し、綺麗な「ブランド/銘柄名＋商品名」を抽出する関数
function cleanProductName(name) {
  if (!name) return '';

  // 1. 『』や「」で囲まれた銘柄名・商品愛称があればそれを優先抽出
  const quoteMatch = name.match(/『(.*?)』|「(.*?)」/);
  if (quoteMatch) {
    const quoted = (quoteMatch[1] || quoteMatch[2]).trim();
    if (quoted.length >= 3 && !/送料無料|ポイント|予約|限定|楽天|ふるさと納税|定期便|選べる|数量限定/.test(quoted)) {
      return quoted;
    }
  }

  // 2. 一般名詞・汎用SEOワード・ノイズの徹底除去
  let cleaned = name
    .replace(/【.*?】|\[.*?\]|（.*?）|\(.*?\)|《.*?》/g, ' ')
    .replace(/※.*/g, '') // ※以降の注意書き削除
    .replace(/送料無料|ポイント\d+倍|実質\d+円|セール|在庫処分|あす楽|即納|予約|限定|数量限定|メーカー直送|代引不可|ふるさと納税|返礼品|お中元|お歳暮|ギフト|プレゼント|父の日|母の日|敬老の日|定期便|選べる|えらべる|選択/gi, ' ')
    .replace(/国産|牛肉|豚肉|鶏肉|魚介|海鮮|貝類|惣菜|おかず|おつまみ|晩酌|ディナー|パーティー|正月|クリスマス|誕生日|冷凍|常温|冷蔵|無添加|訳あり/gi, ' ')
    .replace(/[\s\t\n]+/g, ' ')
    .trim();

  // 単語の重複排除と意味のあるキーワードの結合
  const words = cleaned.split(' ').filter(w => w.length > 1 && !/^[A-Z0-9\-]+$/.test(w));
  
  if (words.length > 0) {
    // 2〜3単語を連結して自然な商品名を作成（例: 「あか牛 ローストビーフ」「豊味館 やわらか赤身」）
    let result = words.slice(0, 3).join(' ');
    if (result.length > 25) {
      result = words.slice(0, 2).join(' ');
    }
    return result.trim();
  }

  // フォールバック: 元の名前からノイズを除去した先頭部分
  let fallback = name.replace(/【.*?】|\[.*?\]/g, '').replace(/[\s\t\n]+/g, ' ').trim();
  return fallback.slice(0, 20).trim();
}

// 2つの商品が同じメーカー・同一蔵元・同一製品の別ショップ出品でないかチェックする判定関数
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

  // 1. クリーン名が完全一致、または一方に他方が含まれる
  if (cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;

  // 2. 代表的なお酒銘柄・蔵元・蒸留所・スイーツ・食品ブランドの一致チェック
  const brands = [
    '獺祭', '久保田', '八海山', '梵', '黒龍', '十四代', '新政', '作', '手取川', '立山', '鳳凰美田', '鍋島', '磯自慢', '田酒', '寫楽', '仙禽', '醸し人九平次', '飛露喜', '花陽浴', '赤武', '勝駒', 'みむろ杉', '楽器正宗', '風の森',
    '山崎', '白州', '響', '余市', '宮城峡', '竹鶴', '知多', 'イチローズモルト', 'マッカラン', 'グレンフィディック', 'ボウモア', 'ラフロイグ', 'アードベッグ', 'タリスカー', 'バランタイン', 'ワイルドターキー', 'メーカーズマーク', 'カバラン', 'アムルット',
    '森伊蔵', '魔王', '村尾', '百年の孤独', '兼八', '佐藤', '富乃宝山', '伊佐美', '赤兎馬', '中々', '吉四六', '萬膳', '川越', '安田', 'フラミンゴオレンジ',
    'オーパスワン', 'シャトー', 'エノテカ', 'ロマネ', 'モエ', 'ヴーヴクリコ', 'ドンペリ', 'ケンゾー', 'カテナ', 'モンテス', 'カレラ',
    'ロイズ', '六花亭', 'ルタオ', 'ヨックモック', 'とらや', '成城石井', '千疋屋', 'ピエールエルメ', 'ゴディバ'
  ];

  for (const b of brands) {
    if (nameA.toUpperCase().includes(b.toUpperCase()) && nameB.toUpperCase().includes(b.toUpperCase())) {
      return true;
    }
  }

  return false;
}

// === 検索キーワード群: 1000記事以上でも被らない超多彩なジャンル別プール ===
const SAKE_KEYWORDS = [
  '日本酒 純米大吟醸 720ml', '日本酒 純米吟醸 720ml', '日本酒 特別純米 720ml',
  '日本酒 無濾過生原酒 720ml', '日本酒 辛口 720ml', '日本酒 山田錦 720ml',
  '日本酒 雄町 720ml', '日本酒 美山錦 720ml', '日本酒 五百万石 720ml',
  '日本酒 山廃 720ml', '日本酒 生酛 720ml', '日本酒 にごり酒 720ml',
  '日本酒 スパークリング 720ml', '日本酒 熟成古酒 720ml', '日本酒 ひやおろし 720ml',
  '日本酒 超辛口 720ml', '日本酒 秋田 地酒 720ml', '日本酒 山形 地酒 720ml',
  '日本酒 青森 地酒 720ml', '日本酒 宮城 地酒 720ml', '日本酒 新潟 地酒 720ml',
  '日本酒 福島 地酒 720ml', '日本酒 長野 地酒 720ml', '日本酒 石川 地酒 720ml',
  '日本酒 福井 地酒 720ml', '日本酒 静岡 地酒 720ml', '日本酒 愛知 地酒 720ml',
  '日本酒 兵庫 灘 地酒 720ml', '日本酒 京都 伏見 地酒 720ml', '日本酒 広島 地酒 720ml',
  '日本酒 高知 辛口 720ml', '日本酒 山口 地酒 720ml', '日本酒 佐賀 地酒 720ml'
];

const WHISKY_KEYWORDS = [
  'ウイスキー シングルモルト 700ml', 'ジャパニーズウイスキー 700ml', 'スコッチウイスキー 700ml',
  'アイラ ウイスキー 700ml', 'スペイサイド ウイスキー 700ml', 'ハイランド ウイスキー 700ml',
  'キャンベルタウン ウイスキー 700ml', 'バーボンウイスキー 700ml', 'ライウイスキー 700ml',
  'シェリーカスク ウイスキー 700ml', 'ピート スモーキー ウイスキー 700ml', 'カスクストレングス ウイスキー',
  'クラフトウイスキー 700ml', 'アイリッシュウイスキー 700ml', '台湾 カバラン ウイスキー',
  'インド アムルット ウイスキー', 'ミズナラ樽 ウイスキー', 'ポートカスク ウイスキー'
];

const SHOCHU_KEYWORDS = [
  '本格焼酎 芋焼酎 720ml', '本格焼酎 麦焼酎 720ml', '本格焼酎 米焼酎 720ml',
  '本格焼酎 黒糖焼酎 720ml', '沖縄 泡盛 古酒 720ml', '沖縄 泡盛 カスク 樽貯蔵',
  '鹿児島 芋焼酎 720ml', '宮崎 芋焼酎 720ml', '大分 麦焼酎 720ml',
  '壱岐 麦焼酎 720ml', '球磨焼酎 米 720ml', '奄美 黒糖焼酎 720ml',
  '八丈島 麦焼酎', '樽熟成 麦焼酎 720ml', '焼き芋 焼酎 720ml',
  '無濾過 芋焼酎 720ml', '前割り 焼酎 720ml', '原酒 焼酎 720ml'
];

const WINE_KEYWORDS = [
  '赤ワイン フルボディ 750ml', '赤ワイン ピノノワール 750ml', '赤ワイン カベルネソーヴィニヨン 750ml',
  '白ワイン 辛口 750ml', '白ワイン シャルドネ 750ml', '白ワイン ソーヴィニヨンブラン 750ml',
  'スパークリングワイン 辛口 750ml', 'シャンパン 辛口 750ml', 'カヴァ スパークリング 750ml',
  'プロセッコ 750ml', 'オレンジワイン 750ml', '自然派 ナチュール ワイン 750ml',
  'ボルドー 赤ワイン 750ml', 'ブルゴーニュ 赤ワイン 750ml', 'シャブリ 白ワイン 750ml',
  'イタリア 赤ワイン バローロ', 'キャンティ クラシコ 750ml', 'スペイン 赤ワイン リオハ 750ml',
  'チリ 赤ワイン 750ml', '南アフリカ ワイン 750ml', 'アルゼンチン マルベック 750ml',
  'ナパバレー 赤ワイン 750ml', 'ニュージーランド 白ワイン 750ml', '日本ワイン 甲州 750ml',
  '日本ワイン マスカットベーリーA 750ml'
];

const CRAFT_BEER_GIN_KEYWORDS = [
  'クラフトビール IPA 単品', 'クラフトビール スタウト 単品', 'クラフトビール ヴァイツェン',
  'クラフトジン 国産 700ml', 'ジャパニーズ クラフトジン 700ml', 'クラフトジン スパイス 700ml'
];

const SWEETS_KEYWORDS = [
  'ふるさと納税 スイーツ 単品', 'ふるさと納税 お菓子 単品', 'ふるさと納税 ケーキ 単品',
  'ふるさと納税 チョコレート 単品', 'ふるさと納税 ガトーショコラ', 'ふるさと納税 チーズケーキ',
  'ふるさと納税 プリン 濃厚', 'ふるさと納税 カヌレ', 'ふるさと納税 アップルパイ',
  'ふるさと納税 モンブラン', 'ふるさと納税 カステラ', 'ふるさと納税 和菓子 単品',
  'ふるさと納税 干し柿 あんぽ柿', 'ふるさと納税 羊羹', 'ふるさと納税 どら焼き',
  'ふるさと納税 フィナンシェ', 'ふるさと納税 クッキー缶', 'ふるさと納税 バウムクーヘン',
  'ふるさと納税 ジェラート アイス 単品', 'ふるさと納税 大福 フルーツ大福'
];

const SNACK_KEYWORDS = [
  'ふるさと納税 おつまみ 単品', 'ふるさと納税 ミックスナッツ', 'ふるさと納税 燻製 ナッツ',
  'ふるさと納税 チーズ おつまみ', 'ふるさと納税 スモークチーズ', 'ふるさと納税 お煎餅 職人',
  'ふるさと納税 柿の種', 'ふるさと納税 燻製 おつまみ', 'ふるさと納税 ホタテ 干物',
  'ふるさと納税 からすみ', 'ふるさと納税 明太子 一本物', 'ふるさと納税 馬刺し 赤身',
  'ふるさと納税 ビーフジャーキー', 'ふるさと納税 生ハム 原木 切り落とし', 'ふるさと納税 地鶏 炭火焼き',
  'ふるさと納税 牛タン 仙台 塩仕込み', 'ふるさと納税 豚の角煮 ラフテー', 'ふるさと納税 鰻 蒲焼 1尾',
  'ふるさと納税 燻製 牡蠣 オイル漬け', 'ふるさと納税 ローストビーフ ブロック'
];

function getCategoryKeywords(subCategory) {
  switch (subCategory) {
    case 'sake': return SAKE_KEYWORDS;
    case 'whisky': return WHISKY_KEYWORDS;
    case 'shochu': return SHOCHU_KEYWORDS;
    case 'wine': return WINE_KEYWORDS;
    case 'craft': return CRAFT_BEER_GIN_KEYWORDS;
    case 'sweets': return SWEETS_KEYWORDS;
    case 'snack': return SNACK_KEYWORDS;
    default: return SAKE_KEYWORDS;
  }
}

// サブカテゴリごとの代表フォールバックキーワード
function getFallbackKeyword(subCategory) {
  switch (subCategory) {
    case 'sake': return '日本酒 720ml 単品';
    case 'whisky': return 'ウイスキー 700ml 単品';
    case 'shochu': return '本格焼酎 720ml 単品';
    case 'wine': return 'ワイン 750ml 単品';
    case 'craft': return 'クラフトジン 700ml';
    case 'sweets': return 'ふるさと納税 スイーツ 単品';
    case 'snack': return 'ふるさと納税 おつまみ 単品';
    default: return '日本酒 720ml';
  }
}

// 1. 楽天APIから2つのメイン商品情報（比較用）を取得
async function fetchRakutenItemPair(primaryObj) {
  const primaryKeyword = typeof primaryObj === 'object' ? primaryObj.keyword : primaryObj;
  const category = typeof primaryObj === 'object' ? primaryObj.category : 'liquor';
  const subCategory = typeof primaryObj === 'object' ? primaryObj.subCategory : 'sake';

  const appId = process.env.RAKUTEN_APPLICATION_ID;
  const affId = process.env.RAKUTEN_AFFILIATE_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;

  if (!appId || !accessKey) {
    throw new Error('RAKUTEN_APPLICATION_ID または RAKUTEN_ACCESS_KEY が設定されていません。');
  }

  // 楽天API呼び出しヘルパー
  const searchRakuten = async (kw, page = 1) => {
    let url = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?format=json&keyword=${encodeURIComponent(kw)}&hits=30&page=${page}&applicationId=${appId}&accessKey=${accessKey}`;
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

  console.log(`[比較対決モード] (ジャンル: ${subCategory}, 検索キーワード: ${primaryKeyword})`);

  let rawItems = await searchRakuten(primaryKeyword, 1);
  if (rawItems.length < 3) {
    const rawItemsP2 = await searchRakuten(primaryKeyword, 2);
    rawItems = [...rawItems, ...rawItemsP2];
  }

  let items = rawItems.map(i => {
    i.Item.cleanName = cleanProductName(i.Item.itemName);
    return i.Item;
  }).filter(item => !isItemAlreadyPosted(item, postedList));

  const findPairInList = (list, maxDiff = 2000) => {
    if (!list || list.length < 2) return null;
    const shuffle = [...list].sort(() => 0.5 - Math.random());
    for (let i = 0; i < shuffle.length; i++) {
      const candA = shuffle[i];
      for (let j = i + 1; j < shuffle.length; j++) {
        const candB = shuffle[j];
        const diff = Math.abs(candA.itemPrice - candB.itemPrice);
        if (diff <= maxDiff && !areItemsTooSimilar(candA, candB)) {
          return { a: candA, b: candB };
        }
      }
    }
    return null;
  };

  let pair = findPairInList(items, 2000);
  if (pair) {
    itemA = pair.a;
    itemB = pair.b;
  }

  if (!itemA || !itemB) {
    console.log(`[補填モード] キーワード「${primaryKeyword}」で候補不足のため、同ジャンル「${subCategory}」内から広く代替検索`);
    const sameSubPool = getCategoryKeywords(subCategory);
    const altPool = sameSubPool.filter(k => k !== primaryKeyword).sort(() => 0.5 - Math.random());
    const combinedCandidates = [...items];

    for (const altKw of altPool.slice(0, 5)) {
      const rawAlt = await searchRakuten(altKw, 1);
      const filteredAlt = rawAlt.map(i => {
        i.Item.cleanName = cleanProductName(i.Item.itemName);
        return i.Item;
      }).filter(item => !isItemAlreadyPosted(item, postedList));
      combinedCandidates.push(...filteredAlt);
    }

    pair = findPairInList(combinedCandidates, 2000);
    if (pair) {
      itemA = pair.a;
      itemB = pair.b;
    }

    if (!itemA || !itemB) {
      const fallbackKw = getFallbackKeyword(subCategory);
      console.log(`[フォールバック検索] 代表キーワード「${fallbackKw}」で確実にペアを取得します`);
      const rawFb = await searchRakuten(fallbackKw, 1);
      const filteredFb = rawFb.map(i => {
        i.Item.cleanName = cleanProductName(i.Item.itemName);
        return i.Item;
      }).filter(item => !isItemAlreadyPosted(item, postedList));
      combinedCandidates.push(...filteredFb);

      pair = findPairInList(combinedCandidates, 2000) || findPairInList(combinedCandidates, 3000);
      if (pair) {
        itemA = pair.a;
        itemB = pair.b;
      }
    }
  }

  if (!itemA || !itemB) {
    console.log('[警告] 有効な商品ペアが見つかりませんでした。');
    return null;
  }

  savePostedItem(itemA);
  savePostedItem(itemB);

  const finalDiff = Math.abs(itemA.itemPrice - itemB.itemPrice);
  console.log(`[比較対決設定確定] [ジャンル:${subCategory}] 商品A: ${cleanProductName(itemA.itemName)} (${itemA.itemPrice}円) VS 商品B: ${cleanProductName(itemB.itemName)} (${itemB.itemPrice}円) [価格差: ${finalDiff}円]`);

  return {
    category,
    subCategory,
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

// 投稿済みキーワードの記録・読み込み（連打を防止）
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
  if (used.length > 50) used.shift();
  fs.writeFileSync('./used_keywords.json', JSON.stringify(used, null, 2));
}

function selectRandomKeyword(excludeList = []) {
  const usedKeywords = getUsedKeywords();
  
  const rand = Math.random();
  let keywordPool = [];
  let category = 'liquor';
  let subCategory = 'sake';

  if (rand < 0.50) {
    category = 'liquor';
    const liquorTypeRand = Math.random();
    if (liquorTypeRand < 0.25) {
      keywordPool = SAKE_KEYWORDS;
      subCategory = 'sake';
    } else if (liquorTypeRand < 0.50) {
      keywordPool = WHISKY_KEYWORDS;
      subCategory = 'whisky';
    } else if (liquorTypeRand < 0.70) {
      keywordPool = SHOCHU_KEYWORDS;
      subCategory = 'shochu';
    } else if (liquorTypeRand < 0.90) {
      keywordPool = WINE_KEYWORDS;
      subCategory = 'wine';
    } else {
      keywordPool = CRAFT_BEER_GIN_KEYWORDS;
      subCategory = 'craft';
    }
  } else {
    category = 'furusato';
    if (Math.random() < 0.4) {
      keywordPool = SWEETS_KEYWORDS;
      subCategory = 'sweets';
    } else {
      keywordPool = SNACK_KEYWORDS;
      subCategory = 'snack';
    }
  }

  const available = keywordPool.filter(k => !usedKeywords.includes(k) && !excludeList.includes(k));
  const pool = available.length > 0 ? available : keywordPool.filter(k => !excludeList.includes(k));
  const chosen = pool[Math.floor(Math.random() * pool.length)] || keywordPool[0];
  saveUsedKeyword(chosen);
  return { keyword: chosen, category, subCategory };
}

// 具体的でリアルな晩酌シーン・食卓・おつまみ準備の導入シード（超多彩・時間軸破綻ゼロ）
const SITUATION_SEEDS = [
  {
    type: 'pairing_test',
    text: '今日は仕事帰りにスーパーで脂の乗ったサーモンの刺身をサクッと買って帰宅。手持ちのお酒と合わせようと思ったけれど、この濃厚な脂にドンピシャで合う最高の一杯を改めて常備しておきたくなって、晩酌しながら真剣に探している。'
  },
  {
    type: 'pairing_test',
    text: '冷蔵庫の豚バラともやしを塩昆布とごま油でササッと炒めただけの超ズボラ手料理。こういうパンチのあるアテを流し込むのに、キレ味抜群の相棒を新しく迎え入れたくなった。'
  },
  {
    type: 'furusato_plan',
    text: '今年のふるさと納税の控除枠をチェック中。毎日の晩酌のクオリティを劇的に引き上げてくれる極上のおつまみ（またはお酒）を1つだけ厳選してポチりたい。'
  },
  {
    type: 'home_bar_upgrade',
    text: '普段のデイリー晩酌用とは別に、休日の前夜に照明を少し落としてちびちび長く楽しめる「ちょっと良いご褒美ボトル」を1本ストックしておきたくて物色中。'
  },
  {
    type: 'craving_rebirth',
    text: '今夜は手頃なハイボールを飲みながら居酒屋メニューを作っていたら、ふと「あぁ、ここは本物の熟成香や樽香があるやつを合わせるべきだった…」と欲が出てしまい、次回の晩酌用に本気で候補を絞り込んでいる。'
  },
  {
    type: 'snack_matching',
    text: 'カマンベールチーズに黒胡椒とオリーブオイルをかけただけの即席つまみ。これをつつきながら、この濃厚なコクと塩気に負けない深みのある1本を探している。'
  },
  {
    type: 'weekend_reward',
    text: '今週もお疲れ様ということで、次の週末にじっくり味わうための特別な1本（または贅沢なアテ）を今から手配しておきたい。'
  },
  {
    type: 'deep_dive',
    text: '普段何気なく飲んでいるけれど、ふとお酒の製法や産地ごとの違いを深掘りしてみたくなり、スペックや造りのこだわりを見比べていたらどうしても決めきれなくなった。'
  },
  {
    type: 'light_snack_night',
    text: '今日は洗い物も面倒なので、ミックスナッツとドライフルーツを小皿に出しただけの静かな夜。こういう乾き物をつまみながら、じっくり向き合える奥深い1本を探している。'
  },
  {
    type: 'meat_craving',
    text: '近所の精肉店で買った赤身の肉をシンプルに塩コショウで焼く予定。この肉汁と旨味をガツンと受け止めてくれる力強い相棒をネットで真剣に見比べている。'
  }
];

// 2. AIで2商品比較型記事の本文・タイトル・ハッシュタグを生成
async function generateArticlePair(itemPair) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;
  const profileContent = getProfileData();

  const fullNameA = itemPair.itemA.itemName;
  const fullNameB = itemPair.itemB.itemName;
  const priceANum = itemPair.itemA.price;
  const priceBNum = itemPair.itemB.price;
  const priceA = priceANum.toLocaleString();
  const priceB = priceBNum.toLocaleString();

  const nameA = itemPair.itemA.cleanName || fullNameA.slice(0, 18);
  const nameB = itemPair.itemB.cleanName || fullNameB.slice(0, 18);

  const priceDiffNum = Math.abs(priceANum - priceBNum);
  const priceDiff = priceDiffNum.toLocaleString();
  const isSamePrice = priceDiffNum === 0;

  const category = itemPair.category || 'liquor';
  const subCategory = itemPair.subCategory || 'sake';

  const defaultTag = subCategory === 'sake' ? '日本酒' :
                     subCategory === 'whisky' ? 'ウイスキー' :
                     subCategory === 'shochu' ? '焼酎' :
                     subCategory === 'wine' ? 'ワイン' :
                     subCategory === 'craft' ? 'クラフト酒' :
                     subCategory === 'sweets' ? 'スイーツ' : 'おつまみ';

  const situationObj = SITUATION_SEEDS[Math.floor(Math.random() * SITUATION_SEEDS.length)];
  const randomSituation = situationObj.text;

  const prompt = `
以下の【プロフィール設定】と【比較する2つの商品情報】を基に、Amebaブログ用の「一人きりの部屋で本気で迷っている個人ブログ記事」を作成してください。

==================================================
【プロフィール設定】
${profileContent}

【今夜の具体的な晩酌シチュエーション（着想源）】
${randomSituation}

【商品A情報】
- 楽天市場での正式商品名（検索用）: ${fullNameA}
- 略称・通称: ${nameA}
- 価格/寄付金額: ${priceA}円

【商品B情報】
- 楽天市場での正式商品名（検索用）: ${fullNameB}
- 略称・通称: ${nameB}
- 価格/寄付金額: ${priceB}円
- 価格状況: ${isSamePrice ? `【完全同額】どちらも同じ${priceA}円` : `価格差 約${priceDiff}円（ほぼ同価格帯）`}
- カテゴリ: ${category === 'liquor' ? `本格お酒（${defaultTag}対決）` : `ふるさと納税（${defaultTag}対決）`}
==================================================

【最重要！投稿者ペルソナと記事のスタンス】

- **ペルソナ**: 30代独身男性。少し根暗で物静か。休日の予定もなく、部屋で一人ちびちび酒を飲むのが唯一の癒やし。
- **トーン＆マナー**: 静かな夜の独白、ちょっと自虐的で寂しげな空気感。
- ❌ **元気すぎる挨拶（「お疲れ様でした！」「おうち晩酌部です！」「〜部です！」など）は絶対に禁止！**
- 「今日も一人きりの部屋で、誰とも話さずグラスを傾けている」「休日に特に予定もない自分の、ささやかすぎる贅沢」といったリアルで静かな独白のトーン。
- 「おすすめはこちら！」といったアフィリエイト臭全開の量産記事は絶対に作らないでください。
- すべての文章や見出しを、使い回しテンプレートではなく**今回の2商品・今夜のシチュエーションに完全に特化したオリジナルな言葉**で執筆してください。

--------------------------------------------------
【絶対に守るべき必須要素】

1. **時間軸のリアリティと静かな冒頭（超重要）**:
   - 定型文（「最近〜を飲み比べてみたくて…」等）は禁止！
   - 「今夜食べるために今ネット注文する」といった時間軸の破綻は絶対に避けること。「手頃なアテで一人静かに飲みながら、次回用の本気ボトルを物色している」「ふるさと納税の枠を一人で延々と吟味している」など、自然な動機から始めてください。

2. **楽天検索用の正式商品名と自然な略称のルール（最重要）**:
   - 後からリンクを差し替えやすくするため、**商品Aのセクション冒頭で1回だけ【楽天市場での正式商品名】『${fullNameA}』を記載**してください。
   - 同様に、**商品Bのセクション冒頭で1回だけ【楽天市場での正式商品名】『${fullNameB}』を記載**してください。
   - **【商品名の呼び方に関する厳重注意】**:
     - 本文や見出しで呼ぶ略称は、『国産 牛肉』『やわらか 赤身』のような**中身がわからない一般名詞・形容詞だけで呼ぶのは絶対に禁止！**
     - 必ず銘柄・産地・特徴が伝わる自然な商品名（例: 『熊本県産あか牛ローストビーフ』『豊味館の原木1kg』『海男の牡蠣オイル漬け』など）を文章中で使って語ってください。

3. **メタ用語の完全禁止**:
   - 「さっきの導入で〜」「導入で書いたように〜」「プロフィールの通り〜」などの**メタ発言・ブログ用語は絶対に使わないこと**。

4. **自分の普段の好み（書き手の立ち位置）を明記**:
   - 「普段はスッキリ辛口派」「甘いお酒よりキレ重視」「夜はウイスキーをちびちび飲むのが好き」「甘いものより塩気のあるおつまみ派」など、判断基準を自然に盛り込む。

5. **テーマの一発提示**:
   - **「え、これどっち買えばいいんだ…？」** と一人で画面の前で本気で悩んでいる様子を伝える。

6. **内容量や仕様への自然な言及**:
   - 正式商品名やスペックに記載されている内容量やタイプ（例：「Aは〇〇g、Bは〇〇g」「Aは四合瓶720ml、Bも720ml」など）に軽く触れてください。
   - **【厳重注意】「6,9,12個から選べる！」などのバリエーション選択肢としての言及は絶対にしないでください！**

7. **価格・スペック比較セクションの完全オリジナル化**:
   - 定型見出しは使わず、今回の2つの特徴に合わせたオリジナル見出しを立て、具体的な味・香り・ボリュームの対比を語ってください。

8. **相性やシーン・ペアリングでの比較軸**:
   - 一人飲みの簡単な手料理やスーパー・コンビニのアテとの相性、夜の静かな晩酌シーンにフォーカスして比較する。

9. **「正直、どっちに惹かれてる？」という見出しと本音**:
   - 「今のところ自分なら7:3で${nameA}寄りだけど…」といった、リアルな本音の傾きを入れる。

10. **まとめと自然な締めくくり**:
    - 「〜部でした！」などの明るい締めは禁止。静かに自問自答しながら、読者に「もし飲んだことある人がいたら、こっそり教えてほしいです」と小さく語りかけて終わること。

--------------------------------------------------
【絶対に排除・修正すべき禁止事項】

- ❌ **元気な部活ノリ・ポジティブすぎるテンション（「おうち晩酌部です！」「〜部」等）の完全禁止**。
- ❌ **未購入なのに実際に飲んだ/食べたように書く表現の禁止**。
- ❌ **「導入で〜」などのメタ用語の完全禁止**。
- ❌ **「〜ですよね」「悩ましい」「マリアージュ…！」「ヨダレが出てきます」などのAI常套句の連発禁止**。
- ❌ **「6,9,12個から選べる」などのバリエーション言及の完全禁止**。
- ❌ **「価格差は約0円」の完全禁止**。
- ❌ **卓上家電の用語（プレート、焼き上がり、煙、お手入れ等）は一切使わないこと！**

--------------------------------------------------
【Markdown見出し構成ルール】
- 記事タイトルは魅力的でブログらしいものにすること（例: 『${nameA}』と『${nameB}』、一人飲みの夜に迎えるならどっち？ / 【本気で迷い中】『${nameA}』VS『${nameB}』... 等）
- h1（#）は本文中で使用禁止。h2（##）およびh3（###）を使用すること。
- 句点「。」や独白の区切りごとに空行を1行挟んで、スマホで読みやすい適度な改行を入れること。
- 心の声などは **太文字** を適度に使用すること。
- 構成案（各セクションの間は \`---\` で区切る）：
  - 冒頭（一人きりの夜の食卓・静かな情景・欲が出た経緯・なぜこの2つなのか・普段の好み）
  - \`---\`
  - \`## 『${nameA}』が気になっている理由\`（※冒頭で1回だけ正式商品名『${fullNameA}』と価格${priceA}円を明記し、特徴を語る）
  - \`---\`
  - \`## もう一つの候補『${nameB}』の魅力\`（※冒頭で1回だけ正式商品名『${fullNameB}』と価格${priceB}円を明記し、特徴を語る）
  - \`---\`
  - \`## （価格やスペック、決定的な違いを比較するオリジナルなh2見出し）\`
  - \`---\`
  - \`## 合わせたい料理やお酒、晩酌シーンで比べてみる\`
  - \`---\`
  - \`## 正直、どっちに惹かれてる？\`
    - \`### ${nameA}に惹かれる理由\`
    - \`### ${nameB}に惹かれる理由\`
    - （「今のところ7:3で〇〇寄りだけど…」という本音）
  - \`---\`
  - \`## （記事の文脈に合わせたオリジナルな締めくくりh2見出し）\`
    - （静かな迷い＋読者への小さな問いかけ）

--------------------------------------------------
出力は必ず以下の有効なJSON形式のみとしてください：
{
  "title": "記事タイトル文字列",
  "contentHtml": "（Markdown形式の本文文字列）",
  "tags": ["${defaultTag}", "晩酌", "一人飲み", "家飲み", "本音比較"]
}
`;

  // --- A. Gemini API 試行（最新モデルローテーション） ---
  if (geminiApiKey) {
    const models = [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-3.1-flash-lite'
    ];
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
        article.tags = Array.isArray(article.tags) && article.tags.length > 0 ? article.tags : [defaultTag, '晩酌', '家飲み', '本音比較'];
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
            { role: 'system', content: 'あなたはAmebaブログで人気の晩酌・お酒好きブロガーです。要求されたJSON形式のみで回答してください。' },
            { role: 'user', content: prompt }
          ],
          model: m.id,
          response_format: { type: 'json_object' }
        });
        const text = chatCompletion.choices[0]?.message?.content || '';
        const article = JSON.parse(text);
        article.contentHtml = convertToCleanHtml(article.contentHtml);
        article.tags = Array.isArray(article.tags) && article.tags.length > 0 ? article.tags : [defaultTag, '晩酌', '家飲み', '本音比較'];
        console.log(`[AI生成] Groq (${m.name}) で比較記事の生成に成功！`);
        return article;
      } catch (err) {
        console.log(`[Groq API (${m.name}) エラー]: ${err.message}`);
      }
    }
  }

  // --- C. フォールバック記事生成 ---
  console.log('AI API不可のため、比較フォールバック記事を生成します。');
  const title = `『${nameA}』と『${nameB}』、次の晩酌で選ぶならどっち？`;

  const rawFallback = `
今夜はちょっと贅沢なおつまみを準備していて、それに合わせる最高の相棒を探してたんですよね。

でも魅力的な候補が2つ見つかってしまって、どれから試すべきか本当に迷う……。

**「え、これどっち買えばいいんだ？」**って本気で悩んでます。

---

## 『${nameA}』が気になっている理由

まず見つけたのが、**『${fullNameA}』**（約${priceA}円）。

レビューを見ていると評判が良くて、内容量のボリューム感や味わいも今夜の気分にピッタリなんですよね。

---

## もう一つの候補『${nameB}』の魅力

そしてもう一つ気になっているのが、**『${fullNameB}』**（約${priceB}円）。

こっちはこっちで特徴が際立っていて、週末にじっくり楽しむのにも最高そう。

---

${isSamePrice ? `## どちらも同じ${priceA}円。値段が全く同じだからこそ内容量やこだわりで迷う

どちらも**同じ${priceA}円**。

値段が全く一緒だからこそ、損得ではなく純粋に「内容量やタイプ」や「合わせたいお料理」で選ぶことになります。` : `## 差額はわずか約${priceDiff}円。この2つの決定的な違いを考える

2つの価格差は**約${priceDiff}円**。

ほぼ同価格帯だからこそ、値段の損得ではなく純粋に「味の好み」や「内容量」で選ぶことになります。`}

---

## 正直、どっちに惹かれてる？

今のところ、自分の中では**7:3で『${nameA}』寄り**。

でも週末になったら『${nameB}』をポチっている気もして、まだ決めきれません。

---

## 結論：今夜の自分の本音は…

どっちも魅力的だから、今夜のメニューと相談しながらもう少し考えてみます！

一応、今回悩んでた商品リンクを貼っておきますね。

皆ならどっちを選びますか？ ぜひ教えてください！
`;

  return {
    title: title,
    contentHtml: convertToCleanHtml(rawFallback),
    tags: [defaultTag, '晩酌', '家飲み', '本音比較']
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
async function postToAmeba(title, rawContentHtml, tags = [], itemPair) {
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
    const safeTags = Array.isArray(tags) ? tags : [];
    const formattedTags = safeTags.map(t => t.startsWith('#') ? t : `#${t}`).join(' ');
    
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

  console.log(`検索キーワード: 「${randomKeyword}」 (ジャンル: ${randomObj.subCategory || randomObj.category})`);
  const itemPair = await fetchRakutenItemPair(randomObj);

  if (!itemPair) {
    console.log('対象商品が見つかりませんでした。スキップします。');
    return;
  }

  console.log(`比較商品A:「${itemPair.itemA.itemName.slice(0, 20)}...」 (${itemPair.itemA.price}円)`);
  console.log(`比較商品B:「${itemPair.itemB.itemName.slice(0, 20)}...」 (${itemPair.itemB.price}円)`);
  console.log('2商品比較記事を生成します...');

  const article = await generateArticlePair(itemPair);

  console.log('Amebaへの自動投稿処理を開始します...');
  await postToAmeba(article.title, article.contentHtml, article.tags, itemPair);
}

main();
