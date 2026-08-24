/*
  Firebaseの設定ファイルです。
  QRコードで写真を受け取る機能を使う場合は、下の値を
  自分のFirebaseプロジェクトの値に書き換えてください。
  （設定方法は README.md を参照）

  設定しない場合、QRボタンを押すと「画像ダウンロード」の
  代替ボタンが表示されます（印刷機能はこの設定がなくても使えます）。
*/
window.FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "000000000000",
  appId: "YOUR_APP_ID"
};
