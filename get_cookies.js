import { chromium } from 'playwright';
import fs from 'fs';

async function getCookies() {
  console.log('ブラウザ（有頭モード）を立ち上げます...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Amebaログイン画面を開きます。画面上でGoogleログインまたはパスワード入力を行ってください。');
  await page.goto('https://dauth.user.ameba.jp/login/ameba');

  console.log('ログインが完了してブログ管理画面またはトップページに遷移するのを待っています...');

  // ログイン成功（ameba.jpへ遷移）するまで待機
  await page.waitForURL((url) => {
    const u = url.toString();
    return u.includes('blog.ameba.jp') || (u.includes('ameba.jp') && !u.includes('auth.user.ameba.jp') && !u.includes('/signin'));
  }, { timeout: 120000 });

  console.log('ログイン完了を検出しました！Cookieを抽出します...');
  await page.waitForTimeout(3000);

  const cookies = await context.cookies();
  const jsonStr = JSON.stringify(cookies);

  fs.writeFileSync('./cookies.json', jsonStr);
  console.log('\n==================================================');
  console.log('【成功】Cookieを取得し ./cookies.json に保存しました！');
  console.log('以下の文字列（JSON）をコピーして、GitHub Secrets の「AMEBA_COOKIES」に登録してください：\n');
  console.log(jsonStr);
  console.log('==================================================\n');

  await browser.close();
}

getCookies().catch(err => {
  console.error('エラーが発生しました:', err.message);
});
