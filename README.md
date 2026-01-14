# zumen (PDF面積/見積 → スプレッドシート保存 + メール送信)

## 構成
- `index.html`: UI（PDF読み込み/採寸/見積作成/保存/送信）
- `gas_proxy.php`: CORS回避のため、同一オリジン（例: `nikosauna.com`）からGASへ中継
- `Code.gs`: Google Apps Script（Drive保存/スプレッドシート保存/メール送信）

## メール送信の流れ
1. `index.html` の「送信」→ `callGasApi('saveEstimate', { payload })`
2. `gas_proxy.php` がGAS Webアプリ（`/exec`）へPOST
3. `Code.gs` の `doPost()` → `saveEstimate(payload)`
4. `saveEstimate()` が
   - スプレッドシートに行を追加
   - `GmailApp.sendEmail(...)` でメール送信
   - `emailResult` をシートの `emailResult` 列に記録

## 重要（今回の修正点）
- メール送信に失敗した場合、**UIで「送信しました」と表示しない**ようにしました。
  - 失敗時は `success:false` として返し、UIは「送信失敗」を表示します。
  - スプレッドシートの `emailResult` 列にも `send_failed: ...` が残ります。

## GAS（Webアプリ）のデプロイ設定チェック
メールが届かない/送れない場合、まずここを確認してください。

1. Apps Script エディタ → **デプロイ** → **新しいデプロイ**
2. 種類: **ウェブアプリ**
3. **実行するユーザー**:
   - 通常は「自分」推奨（送信元/権限を固定できる）
4. **アクセスできるユーザー**:
   - `gas_proxy.php` 経由で叩くなら、一般的に「全員」または用途に合わせて設定
5. 初回は権限承認が必要です（Gmail送信/Spreadsheet/Drive）
   - 承認が終わっていないと `GmailApp.sendEmail` が失敗します

### Script Properties（推奨）
`Code.gs` の `getConfig()` は Script Properties を優先します。
- `SPREADSHEET_ID`
- `ESTIMATE_SHEET_NAME`
- `DRIVE_FOLDER_ID`
- `ADMIN_EMAIL`（BCC控え先。例：`info@g-knowthyself.com` / 不要なら空でもOK）
- `API_KEY`（使う場合のみ）

## 送信ログの見方
スプレッドシート（`ESTIMATE_SHEET_NAME`）の `emailResult` 列:
- `sent_with_bcc`
- `sent_no_admin_email`
- `send_failed: ...`


