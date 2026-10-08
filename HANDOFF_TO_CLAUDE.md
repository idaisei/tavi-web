# Focus Desk Web 改良 引き継ぎ

更新日: 2026-10-08

## 目的

公開中の `focus/` を元祖iOS版へ近づけ、複数の試験日登録と、iPhoneで使える通知の入口を追加する。

## 完了したこと

- HomeをiOS版に合わせて、右上設定、最近使った科目、連続日数・レベル進捗・通算時間、2つのフッター操作へ変更
- 科目・タスクごとに複数の試験／締め切りを登録可能に変更
- 既存の `examDate` / `severity` データは初回読込時に `exams[]` へ移行
- これから来る最も近い試験を優先順位と理由表示に使用
- 終了予定、カウントダウン、時間指定休憩のブラウザ通知を追加
- Service Workerを追加し、通知タップ時にFocus Deskを開く動作を追加
- iOS版と同じXP計算式に揃え、初期値が負になる既存不具合を修正

## 変更ファイル

- `focus/index.html`
- `focus/app.js`
- `focus/store.js`
- `focus/manifest.webmanifest`
- `focus/sw.js`（新規）
- `README.md`

## 確認結果

- ローカルHTTPサーバーで画面起動: OK
- 複数試験2件の登録、優先表示、再読込後の保持: OK
- セッション開始後の「最近使ったもの」表示: OK
- 通知設定UIとiPhone向け案内: OK
- `git diff --check`: OK
- `tools/check-privacy.sh`: OK
- manifest JSON構文: OK

## 通知の制約

現在はページが動作中のセッション通知。iPhoneではホーム画面へ追加したWebアプリから許可する。サイトを完全に終了した後も確実に届けるには、Push購読を保存して送信するバックエンドが必要。

## Git

- branch: `main`
- base commit: `84ddb16 Add private Notion sync bridge`
- 状態: 未コミット、未push

## 次に行うこと

1. iPhoneのホーム画面版で通知許可と終了予定通知を実機確認
2. 差分レビュー後にコミット、GitHub Pagesへ反映
3. 完全終了後の通知が必要ならWeb Pushバックエンドの方式を決める
