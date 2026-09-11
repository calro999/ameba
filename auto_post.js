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

// === テーマ別お菓子・おつまみ検索キーワード群（お菓子ベースの家飲みペアリング） ===
const SNACK_THEMES = [
  {
    themeId: 'salty_crunchy',
    themeName: '塩気と香ばしさがたまらない煎餅・米菓・スナック',
    alcoholCategory: 'shochu_beer',
    alcoholName: 'キレのある麦焼酎ロックや炭酸割り、辛口ハイボール',
    snackKeywords: [
      'ふるさと納税 お煎餅 職人 手焼き', 'ふるさと納税 柿の種 高級 専門店', 'ふるさと納税 あられ おかき 詰め合わせなし',
      'ふるさと納税 ポテトチップス クラフト', 'ふるさと納税 揚げせんべい 無添加', 'ふるさと納税 枝豆 スナック フリーズドライ',
      'ふるさと納税 そら豆 揚げ 菓子 塩', 'ふるさと納税 ごぼうチップス 国産', 'ふるさと納税 イカ天 瀬戸内レモン',
      'ふるさと納税 カレー せんべい 濃厚', 'ふるさと納税 エビせんべい 海老 濃厚', 'ふるさと納税 パスタスナック 揚げパスタ'
    ],
    alcoholKeywords: [
      '本格焼酎 麦焼酎 720ml', '壱岐 麦焼酎 720ml', '大分 麦焼酎 720ml', 'ウイスキー ハイボール 700ml',
      'ジャパニーズ クラフトジン 700ml', '本格焼酎 米焼酎 720ml'
    ]
  },
  {
    themeId: 'chocolate_cacao',
    themeName: 'カカオ香る濃厚チョコレート・ビタースイーツ',
    alcoholCategory: 'whisky_brandy',
    alcoholName: 'スモーキーなアイラウイスキーや重厚なシェリー樽モルト',
    snackKeywords: [
      'ふるさと納税 ガトーショコラ 濃厚', 'ふるさと納税 チョコレート ビター 単品', 'ふるさと納税 生チョコレート カカオ',
      'ふるさと納税 テリーヌショコラ 濃厚', 'ふるさと納税 オランジェット オレンジピール チョコ', 'ふるさと納税 チョコブラウニー 濃厚',
      'ふるさと納税 割れチョコ ハイカカオ', 'ふるさと納税 ボンボンショコラ 高級', 'ふるさと納税 フォンダンショコラ'
    ],
    alcoholKeywords: [
      'ウイスキー シングルモルト 700ml', 'アイラ ウイスキー 700ml', 'シェリーカスク ウイスキー 700ml',
      'スコッチウイスキー 700ml', 'ポートカスク ウイスキー', '本格焼酎 黒糖焼酎 720ml'
    ]
  },
  {
    themeId: 'cheese_baked',
    themeName: 'コク深いチーズケーキ・チーズ焼き菓子',
    alcoholCategory: 'wine_whisky',
    alcoholName: '樽香の効いた白ワイン（シャルドネ）や重口赤ワイン',
    snackKeywords: [
      'ふるさと納税 バスクチーズケーキ 濃厚', 'ふるさと納税 チーズテリーヌ', 'ふるさと納税 ベイクドチーズケーキ 熟成',
      'ふるさと納税 チーズ クッキー 塩気', 'ふるさと納税 チーズ サブレ 濃厚', 'ふるさと納税 ゴルゴンゾーラ チーズケーキ',
      'ふるさと納税 チーズタルト 濃厚', 'ふるさと納税 カマンベール チーズケーキ', 'ふるさと納税 パルミジャーノ 焼き菓子'
    ],
    alcoholKeywords: [
      '白ワイン シャルドネ 750ml', '赤ワイン フルボディ 750ml', '赤ワイン ピノノワール 750ml',
      '白ワイン 辛口 750ml', 'スパークリングワイン 辛口 750ml', '日本ワイン 甲州 750ml'
    ]
  },
  {
    themeId: 'baked_butter',
    themeName: '焦がしバター香るフィナンシェ・洋焼き菓子',
    alcoholCategory: 'bourbon_brandy',
    alcoholName: 'バニラ香あふれるバーボンやフルーティーなスペイサイドモルト',
    snackKeywords: [
      'ふるさと納税 フィナンシェ 発酵バター', 'ふるさと納税 カヌレ フランス 焼き菓子', 'ふるさと納税 マドレーヌ 濃厚 バター',
      'ふるさと納税 ガレットブルトンヌ バター', 'ふるさと納税 パウンドケーキ フルーツ', 'ふるさと納税 フロランタン アーモンド',
      'ふるさと納税 クッキー缶 職人 バター', 'ふるさと納税 アップルパイ シナモン', 'ふるさと納税 レモンケーキ ピール'
    ],
    alcoholKeywords: [
      'バーボンウイスキー 700ml', 'スペイサイド ウイスキー 700ml', 'ハイランド ウイスキー 700ml',
      'ミズナラ樽 ウイスキー 700ml', 'ライウイスキー 700ml', 'アイリッシュウイスキー 700ml'
    ]
  },
  {
    themeId: 'wagashi_anko',
    themeName: '上品な甘みとコクの和菓子・栗・干し柿',
    alcoholCategory: 'sake_shochu',
    alcoholName: '熟成古酒泡盛、旨味の強い山廃純米酒、濃厚な芋焼酎',
    snackKeywords: [
      'ふるさと納税 干し柿 あんぽ柿', 'ふるさと納税 羊羹 栗 濃厚', 'ふるさと納税 どら焼き 粒あん',
      'ふるさと納税 かりんとう 黒糖 高級', 'ふるさと納税 芋けんぴ 塩', 'ふるさと納税 栗きんとん 国産栗',
      'ふるさと納税 最中 粒あん 職人', 'ふるさと納税 大福 塩大福 豆大福', 'ふるさと納税 カステラ 熟成'
    ],
    alcoholKeywords: [
      '日本酒 山廃 720ml', '日本酒 生酛 720ml', '沖縄 泡盛 古酒 720ml',
      '本格焼酎 芋焼酎 720ml', '本格焼酎 黒糖焼酎 720ml', '日本酒 熟成古酒 720ml'
    ]
  },
  {
    themeId: 'nuts_driedfruit',
    themeName: '素材そのままの素焼きナッツ・燻製・ドライフルーツ',
    alcoholCategory: 'whisky_gin',
    alcoholName: 'ロックで愉しむスコッチウイスキーや香り高いクラフトジン',
    snackKeywords: [
      'ふるさと納税 ミックスナッツ 無塩 素焼き', 'ふるさと納税 燻製 ナッツ ピート', 'ふるさと納税 マカダミアナッツ 殻付き',
      'ふるさと納税 ピスタチオ ロースト 塩', 'ふるさと納税 ドライフルーツ 砂糖不使用', 'ふるさと納税 無花果 イチジク ドライフルーツ',
      'ふるさと納税 カシューナッツ ロースト', 'ふるさと納税 燻製 ピスタチオ', 'ふるさと納税 デーツ ドライフルーツ'
    ],
    alcoholKeywords: [
      'ウイスキー シングルモルト 700ml', 'ジャパニーズ クラフトジン 700ml', 'スコッチウイスキー 700ml',
      'アイラ ウイスキー 700ml', 'キャンベルタウン ウイスキー 700ml', '本格焼酎 麦焼酎 720ml'
    ]
  }
];

// 楽天API呼び出しヘルパー（単体キーワード）
async function searchRakutenItems(kw, count = 15) {
  const appId = process.env.RAKUTEN_APPLICATION_ID;
  const affId = process.env.RAKUTEN_AFFILIATE_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;

  if (!appId || !accessKey) {
    throw new Error('RAKUTEN_APPLICATION_ID または RAKUTEN_ACCESS_KEY が設定されていません。');
  }

  let url = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?format=json&keyword=${encodeURIComponent(kw)}&hits=${count}&page=1&applicationId=${appId}&accessKey=${accessKey}`;
  if (affId) url += `&affiliateId=${affId}`;

  try {
    const res = await fetch(url);
    const json = await res.json();
    if (json && json.Items && json.Items.length > 0) {
      return json.Items.map(i => i.Item).filter(i => isMainProduct(i));
    }
  } catch (e) {
    console.log(`[Rakuten API エラー (${kw})]:`, e.message);
  }
  return [];
}

// 投稿済みキーワードの記録・読み込み（テーマやキーワードの連続重複を防止）
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

// 3〜4つの独立したおつまみ ＋ 1つの相棒となるお酒を楽天APIから取得
async function fetchSnackAndAlcoholGroup() {
  const usedKeywords = getUsedKeywords();
  const postedList = getPostedItems();

  // 1. テーマをランダム選定（直近で使われていないテーマを優先）
  const theme = SNACK_THEMES[Math.floor(Math.random() * SNACK_THEMES.length)];
  console.log(`[選定テーマ]: ${theme.themeName} (想定酒: ${theme.alcoholName})`);

  // 2. おつまみキーワードをシャッフルして3〜4商品を取得
  const shuffledSnackKws = [...theme.snackKeywords].sort(() => 0.5 - Math.random());
  const selectedSnacks = [];

  for (const kw of shuffledSnackKws) {
    if (selectedSnacks.length >= 3) break;
    const items = await searchRakutenItems(kw, 15);
    for (const raw of items) {
      raw.cleanName = cleanProductName(raw.itemName);
      if (!isItemAlreadyPosted(raw, postedList) && !selectedSnacks.some(s => areItemsTooSimilar(s, raw))) {
        selectedSnacks.push(raw);
        savePostedItem(raw);
        saveUsedKeyword(kw);
        break;
      }
    }
  }

  // もし3つ未満なら、他テーマのキーワードからも補填
  if (selectedSnacks.length < 3) {
    console.log('[補填] おつまみ候補が足りないため他テーマから追加探索...');
    const allSnackKws = SNACK_THEMES.flatMap(t => t.snackKeywords).sort(() => 0.5 - Math.random());
    for (const kw of allSnackKws) {
      if (selectedSnacks.length >= 3) break;
      const items = await searchRakutenItems(kw, 10);
      for (const raw of items) {
        raw.cleanName = cleanProductName(raw.itemName);
        if (!isItemAlreadyPosted(raw, postedList) && !selectedSnacks.some(s => areItemsTooSimilar(s, raw))) {
          selectedSnacks.push(raw);
          savePostedItem(raw);
          break;
        }
      }
    }
  }

  // 3. このおつまみ達に合わせる「お酒」を1本取得
  const shuffledAlcKws = [...theme.alcoholKeywords].sort(() => 0.5 - Math.random());
  let selectedAlcohol = null;

  for (const kw of shuffledAlcKws) {
    const alcItems = await searchRakutenItems(kw, 15);
    for (const raw of alcItems) {
      raw.cleanName = cleanProductName(raw.itemName);
      if (!isItemAlreadyPosted(raw, postedList)) {
        selectedAlcohol = raw;
        savePostedItem(raw);
        saveUsedKeyword(kw);
        break;
      }
    }
    if (selectedAlcohol) break;
  }

  // お酒が見つからない場合のフォールバック
  if (!selectedAlcohol) {
    const fbItems = await searchRakutenItems('ウイスキー シングルモルト 700ml', 10);
    if (fbItems.length > 0) {
      selectedAlcohol = fbItems[0];
      selectedAlcohol.cleanName = cleanProductName(selectedAlcohol.itemName);
    }
  }

  if (selectedSnacks.length < 2 || !selectedAlcohol) {
    console.log('[警告] 充分な商品グループが取得できませんでした。');
    return null;
  }

  console.log(`[商品グループ確定] おつまみ ${selectedSnacks.length}品 ＆ お酒 1品`);
  selectedSnacks.forEach((s, idx) => console.log(`  おつまみ${idx + 1}: ${s.cleanName} (${s.itemPrice}円)`));
  console.log(`  相棒のお酒: ${selectedAlcohol.cleanName} (${selectedAlcohol.itemPrice}円)`);

  return {
    theme,
    snacks: selectedSnacks.map(s => ({
      itemName: s.itemName,
      cleanName: s.cleanName,
      itemUrl: s.affiliateUrl || s.itemUrl,
      imageUrl: s.mediumImageUrls?.[0]?.imageUrl || s.mediumImageUrls?.[0] || '',
      price: s.itemPrice
    })),
    alcohol: {
      itemName: selectedAlcohol.itemName,
      cleanName: selectedAlcohol.cleanName,
      itemUrl: selectedAlcohol.affiliateUrl || selectedAlcohol.itemUrl,
      imageUrl: selectedAlcohol.mediumImageUrls?.[0]?.imageUrl || selectedAlcohol.mediumImageUrls?.[0] || '',
      price: selectedAlcohol.itemPrice
    }
  };
}

// 具体的でリアルな「仕事終わりの部屋・おつまみ×お酒探訪」冒頭シード（超多彩バリエーション）
const SITUATION_SEEDS = [
  '仕事の後に美味しいものと美味しいお酒の組み合わせは格別ですよね。最近は一人きりの部屋で晩酌しながら、ネットで美味しそうなおつまみとお酒を探すことに静かにハマっています。今夜は無性に「塩気のきいた香ばしいアテ」が欲しくなって、画面とにらめっこ中。',
  '今日も長い一日が終わって、誰もいない部屋でプシュッと缶を開ける瞬間。やっぱり仕事終わりの晩酌には、噛めば噛むほど味が出るようなジューシーな肉や燻製が欲しくなる。それに負けないパンチのあるお酒は何がいいか、一人で真剣に妄想しています。',
  '仕事帰りのスーパーで適当な惣菜をつまみつつ、ふと「もっと至福の組み合わせはないものか」と欲が出てしまった夜。濃厚なチーズ系のアテをいくつか候補に並べながら、これに合わせるなら重口の赤か、それとも樽香のあるウイスキーか…と贅沢な悩みに没頭しています。',
  '平日の夜、静まり返った部屋。仕事終わりの疲れた体に染み渡るような、海の幸の凝縮された旨味が恋しくなりました。珍味系の極上おつまみを物色しつつ、合わせるならキリッと冷やした日本酒か辛口白ワインか、一人きりの居酒屋会議が止まりません。',
  '仕事を終えて部屋の明かりを少し落とし、自分への小さなご褒美時間。甘さ控えめのビターなチョコや香ばしい燻製ナッツをつまみながら、ロックでちびちびやれる銘酒との組み合わせを夜な夜な探訪しています。'
];

// 2. AIでおつまみ3〜4選 ＋ 合わせるお酒のペアリング悩む記事を生成
async function generateArticleGroup(itemGroup) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;
  const profileContent = getProfileData();

  const theme = itemGroup.theme;
  const snacks = itemGroup.snacks;
  const alcohol = itemGroup.alcohol;

  const situation = SITUATION_SEEDS[Math.floor(Math.random() * SITUATION_SEEDS.length)];

  // おつまみリストの文字列構築（正規商品名＋価格＋クリーン略称）
  const snackListText = snacks.map((s, i) => {
    return `【候補${i + 1}】
- 楽天市場での正式商品名（検索用）: ${s.itemName}
- 略称・特徴: ${s.cleanName}
- 寄付金額/価格: ${s.price.toLocaleString()}円`;
  }).join('\n\n');

  const alcoholText = `- 楽天市場での正式商品名（検索用）: ${alcohol.itemName}
- 略称・銘柄名: ${alcohol.cleanName}
- 価格/寄付金額: ${alcohol.price.toLocaleString()}円
- お酒の方向性: ${theme.alcoholName}`;

  const prompt = `
以下の【プロフィール設定】と【今夜のテーマ・おつまみ候補とお酒情報】を基に、Amebaブログ用の「一人きりの部屋でおつまみ選びとお酒のペアリングに本気で頭を抱える個人ブログ記事」を作成してください。

==================================================
【プロフィール設定】
${profileContent}

【今夜の具体的な晩酌シチュエーション・冒頭の着想源】
${situation}

【今夜のテーマ】
${theme.themeName}

【厳選したおつまみ候補（3品）】
${snackListText}

【合わせたい相棒のお酒（1品）】
${alcoholText}
==================================================

【最重要！投稿者ペルソナと記事のスタンス】

- **ペルソナ**: 30代独身男性。少し根暗で物静か。休日の予定もなく、部屋で一人ちびちび酒を飲むのが唯一の癒やし。
- **トーン＆マナー**: 静かな夜の独白、ちょっと自虐的で寂しげな空気感。
- ❌ **元気すぎる挨拶（「お疲れ様でした！」「おうち晩酌部です！」「〜部です！」など）は絶対に禁止！**
- 「仕事が終わって静まり返った部屋。缶をプシュッと開けて、美味しいおつまみとお酒の組み合わせを探す時間が唯一の救い…」というリアルな孤独感と晩酌への強い情熱。
- 「おすすめはこちら！」「ランキングまとめ！」といったアフィリエイト臭全開の量産記事は絶対に作らないでください。
- すべての文章や見出しを、使い回しテンプレートではなく**今回のテーマ・候補商品に特化したオリジナルの言葉**で執筆してください。

--------------------------------------------------
【絶対に守るべき必須要素】

1. **情景が目に浮かぶ冒頭（超重要）**:
   - 「仕事の後に美味しいものと美味しいお酒の組み合わせは格別ですよね。最近は一人きりの部屋で晩酌しながら、ネットで美味しそうなお菓子やおつまみ、そしてお酒を探すことに静かにハマっています」といった自然な導入からスタート。
   - 「今夜は無性に『${theme.themeName}』が欲しくなり、画面にかじりついて候補を絞り込んでいる…」と繋げる。

2. **SEO＆アメブロ公式ジャンル対策（「家飲み」「晩酌」の自然な織り込み）**:
   - アメブロ「家飲み」ジャンルでの露出を高めるため、記事全体（タイトル、冒頭、ペアリング検討、結び）を通じて、**「家飲み」「晩酌」という単語を不自然にならない頻度（記事全体でそれぞれ2〜4回程度）で自然に織り込んでください**。過度な連発（スパム的詰め込み）は禁止ですが、一人で部屋で楽しむ「家飲み」の空気感を言葉に宿らせてください。

3. **楽天検索用の正式商品名と自然な略称のルール（最重要）**:
   - 後からリンクを差し替えやすくするため、**各お菓子・おつまみ（候補1〜3）とお酒のセクション冒頭で、それぞれ1回だけ【楽天市場での正式商品名】を正確に記載**してください。
   - 本文や見出しでは、『国産 牛肉』『やわらか 赤身』のような**中身がわからない一般名詞・形容詞だけで呼ぶのは禁止**！必ず特徴やブランドが伝わる自然な商品名（例: 『${snacks[0].cleanName}』など）で呼んでください。

4. **お菓子・おつまみ3候補の徹底的な吟味と葛藤**:
   - なぜこの3つで迷っているのか？（甘み・塩気・カカオの深み・バター感・食感、一人での家飲み用としてのサイズ感など）それぞれの魅力と違いを、お酒好きならではの目線で細かく語る。

5. **相棒のお酒とのペアリング妄想**:
   - 「このお菓子・おつまみに合わせるなら、どんなお酒がいいか？」を真剣に考える。
   - 「重口の赤ワインか？それともスモーキーなウイスキーか？」「キレのある麦焼酎か、甘露な古酒か？」「ハイボールでスッキリ合わせるか、ロックで濃厚に寄り添わせるか？」といった葛藤を挟みつつ、今回ピックアップした『${alcohol.cleanName}』との相性を語る。

6. **正直、今夜の自分の本音（どれに傾いているか）**:
   - 「今のところ一番惹かれているのは候補〇〇だけど、今夜の家飲みの気分を考えると候補〇〇も捨てがたい…」というリアルな揺らぎ。

7. **静かな締めくくり**:
   - 「部屋には相変わらず時計の秒針の音しか聞こえませんが、今夜はこのペアリング妄想を肴にもう一杯だけ飲んで寝ようと思います。皆さんはこの組み合わせなら、どの家飲みスイーツが気になりますか？」と、読者に小さく語りかけて終わる。

--------------------------------------------------
【絶対に排除・修正すべき禁止事項】

- ❌ **元気な部活ノリ・ポジティブすぎるテンション（「おうち晩酌部です！」「〜部」等）の完全禁止**。
- ❌ **未購入なのに実際に食べた/飲んだように書く表現の禁止**。
- ❌ **「導入で〜」などのメタ用語の完全禁止**。
- ❌ **「〜ですよね」「悩ましい」「マリアージュ…！」「ヨダレが出てきます」などのAI常套句の連発禁止**。
- ❌ **卓上家電の用語（プレート、焼き上がり、煙、お手入れ等）は一切使わないこと！**

--------------------------------------------------
【Markdown見出し構成ルール】
- 記事タイトルは魅力的でブログらしいものにすること（例: 仕事終わりの静かな家飲みに。『${snacks[0].cleanName}』と合わせる相棒の一杯を迷う夜 / 【至福の家飲みペアリング】こだわりのお菓子3選と、今夜合わせたいお酒... 等）
- 記事タイトルにも可能なら「家飲み」または「晩酌」を自然に1回含めるとベター。
- h1（#）は本文中で使用禁止。h2（##）およびh3（###）を使用すること。
- 句点「。」や独白の区切りごとに空行を1行挟んで、スマホで読みやすい適度な改行を入れること。
- 心の声などは **太文字** を適度に使用すること。
- 構成案（各セクションの間は \`---\` で区切る）：
  - 冒頭（仕事終わりの静かな部屋・一人家飲みの時間・お菓子とお酒のペアリング探訪）
  - \`---\`
  - \`## 今夜迷っている極上のお菓子・おつまみ3選\`
    - \`### 1. 『${snacks[0].cleanName}』\`（※冒頭に【楽天市場での正式商品名】『${snacks[0].itemName}』と価格を明記）
    - \`### 2. 『${snacks[1].cleanName}』\`（※冒頭に【楽天市場での正式商品名】『${snacks[1].itemName}』と価格を明記）
    - \`### 3. 『${snacks[2] ? snacks[2].cleanName : 'もう一つの候補'}』\`（※冒頭に正式商品名と価格を明記）
  - \`---\`
  - \`## これらに合わせるならどんなお酒がいいか？（相棒の一杯を考える）\`
    - （「ワインかウイスキーか焼酎か…」というお酒選びの思考過程）
    - \`### 相棒の候補：『${alcohol.cleanName}』\`（※冒頭に【楽天市場での正式商品名】『${alcohol.itemName}』と価格を明記）
  - \`---\`
  - \`## 正直、今夜の自分の本音は…\`
    - （どれをポチるか迷うリアルな心理）
  - \`---\`
  - \`## 静かな部屋で、もう一杯だけ\`
    - （読者への静かな問いかけで終了）

--------------------------------------------------
出力は必ず以下の有効なJSON形式のみとしてください：
{
  "title": "記事タイトル文字列",
  "contentHtml": "（Markdown形式の本文文字列）",
  "tags": ["家飲み", "晩酌", "おつまみ", "一人飲み", "ふるさと納税"]
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
        article.tags = Array.isArray(article.tags) && article.tags.length > 0 ? article.tags : ['おつまみ', '晩酌', '一人飲み', '家飲み', 'ふるさと納税'];
        console.log(`[AI生成] Gemini (${modelName}) で記事の生成に成功！`);
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
            { role: 'system', content: 'あなたはAmebaブログで人気の晩酌ブロガーです。要求されたJSON形式のみで回答してください。' },
            { role: 'user', content: prompt }
          ],
          model: m.id,
          response_format: { type: 'json_object' }
        });
        const text = chatCompletion.choices[0]?.message?.content || '';
        const article = JSON.parse(text);
        article.contentHtml = convertToCleanHtml(article.contentHtml);
        article.tags = Array.isArray(article.tags) && article.tags.length > 0 ? article.tags : ['おつまみ', '晩酌', '一人飲み', '家飲み', 'ふるさと納税'];
        console.log(`[AI生成] Groq (${m.name}) で記事の生成に成功！`);
        return article;
      } catch (err) {
        console.log(`[Groq API (${m.name}) エラー]: ${err.message}`);
      }
    }
  }

  // --- C. フォールバック記事生成 ---
  console.log('AI API不可のため、フォールバック記事を生成します。');
  const title = `仕事終わりの部屋で。『${snacks[0].cleanName}』と相棒のお酒を迷う夜`;

  const rawFallback = `
仕事の後に美味しいものと美味しいお酒の組み合わせは格別ですよね。
最近は一人きりの部屋で晩酌しながら、ネットで美味しそうなおつまみとお酒を探すことにハマっています。

今夜は無性に**「${theme.themeName}」**が欲しくなって、画面の前で頭を抱えています。

---

## 今夜迷っている極上のおつまみ候補

### 1. 『${snacks[0].cleanName}』
【楽天市場での正式商品名】『${snacks[0].itemName}』（${snacks[0].price.toLocaleString()}円）

素材の旨味が凝縮されていて、一人でちびちびやるには最高のボリューム感。

### 2. 『${snacks[1].cleanName}』
【楽天市場での正式商品名】『${snacks[1].itemName}』（${snacks[1].price.toLocaleString()}円）

こっちはこっちでまた違ったアプローチで攻めてきていて、甲乙つけがたい…。

${snacks[2] ? `### 3. 『${snacks[2].cleanName}』
【楽天市場での正式商品名】『${snacks[2].itemName}』（${snacks[2].price.toLocaleString()}円）

贅沢感という点ではこれが一番かもしれません。` : ''}

---

## これらに合わせるならどんなお酒がいいか？

おつまみを見ながら、「合わせるお酒はどうしようか」と考える時間が一番楽しいんですよね。

赤ワインよりもウイスキーか？ それともキレのある麦焼酎か…？

### 相棒の候補：『${alcohol.cleanName}』
【楽天市場での正式商品名】『${alcohol.itemName}』（${alcohol.price.toLocaleString()}円）

この一杯があれば、今夜のアテのポテンシャルを120%引き出してくれる気がしています。

---

## 正直、今夜の自分の本音は…

どれを選んでも間違いないのは分かっているんですが、一人で画面を見つめていると迷いは尽きません。

今夜はこの妄想を肴に、手元の薄いハイボールを飲み干して寝ることにします。

それでは、おやすみなさい。
`;

  return {
    title: title,
    contentHtml: convertToCleanHtml(rawFallback),
    tags: ['おつまみ', '晩酌', '一人飲み', '家飲み', 'ふるさと納税']
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
async function postToAmeba(title, rawContentHtml, tags = [], itemGroup) {
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
    
    // カバー画像にはおつまみ1つ目の画像を使用
    const coverUrl = itemGroup.snacks[0]?.imageUrl || itemGroup.alcohol?.imageUrl || '';

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
    }, { tagStr: formattedTags, coverUrl }).catch(() => {});

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
    console.log('【安全運用成功】生成したおつまみ×お酒記事を Ameba の「下書き」として正常保存しました！');
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
  console.log('=== おつまみ×お酒ペアリング探訪モード開始 ===');
  const itemGroup = await fetchSnackAndAlcoholGroup();

  if (!itemGroup) {
    console.log('対象商品グループが見つかりませんでした。スキップします。');
    return;
  }

  console.log('おつまみ3品＋お酒1品の探訪・比較記事をAI生成します...');
  const article = await generateArticleGroup(itemGroup);

  console.log('Amebaへの自動投稿処理を開始します...');
  await postToAmeba(article.title, article.contentHtml, article.tags, itemGroup);
}

main();
