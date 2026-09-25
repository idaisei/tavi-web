# 本人版（Google Apps Script）

公開体験版はGitHub Pagesのまま使い、本人版だけをGoogleログイン必須で開くための中継です。
Notionのトークンはブラウザや公開リポジトリへ渡さず、Apps Scriptのスクリプトプロパティだけに保存します。

必要なスクリプトプロパティ：

- `NOTION_TOKEN`
- `FOCUS_DATA_SOURCE_ID`
- `TAVI_DATA_SOURCE_ID`

ウェブアプリのアクセス権は必ず「自分のみ」にします。デプロイURLの末尾へ
`?app=focus` または `?app=tabi` を付けると、それぞれを別URLとして開けます。
