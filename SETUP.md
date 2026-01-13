# GCP Pub/Sub リアルタイム通知サービス セットアップガイド

## アーキテクチャ

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────▶│  Cloud Run  │────▶│   Pub/Sub   │
│  (Browser)  │◀────│   Server    │◀────│    Topic    │
└─────────────┘ SSE └─────────────┘     └─────────────┘
```

## 前提条件

- Google Cloud アカウント
- gcloud CLI インストール済み
- Node.js 18以上

## デモモード

第三者にアプリを公開する際、GCPリソースへの書き込みを防ぎたい場合は**デモモード**を使用します。

### デモモードの特徴

- 通知送信フォームが無効化される（UIはグレーアウト表示）
- `/notify`エンドポイントへのPOSTが拒否される
- Pub/Sub初期化がスキップされる（GCPへの接続なし）
- 接続時にサンプル通知が自動的に表示される

### デモモードの有効化

```bash
# 環境変数で設定
DEMO_MODE=true npm start

# または.envファイルで設定
echo "DEMO_MODE=true" >> .env
npm start
```

### Cloud Runでデモモードを使用

```bash
gcloud run deploy realtime-notify \
  --source . \
  --region asia-northeast1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "DEMO_MODE=true"
```

デモモードではGCP認証情報やPub/Sub設定は不要です。

---

## ローカル開発

### 1. 依存関係のインストール

```bash
npm install
```

### 2. ローカルモードで起動（Pub/Subなし）

```bash
npm start
```

ブラウザで http://localhost:8080 を開く

### 3. GCP認証付きで起動

```bash
# GCPにログイン
gcloud auth application-default login

# 環境変数を設定
cp .env.example .env
# .envファイルを編集してGCP_PROJECT_IDを設定

npm start
```

## GCPへのデプロイ

### 1. GCPプロジェクトの設定

```bash
# プロジェクトIDを設定
export PROJECT_ID=your-project-id
gcloud config set project $PROJECT_ID

# 必要なAPIを有効化
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable pubsub.googleapis.com
```

### 2. Pub/Subトピックとサブスクリプションの作成

```bash
# トピック作成
gcloud pubsub topics create notifications

# サブスクリプション作成（Pull型）
gcloud pubsub subscriptions create notifications-sub \
  --topic=notifications
```

### 3. Cloud Runにデプロイ

```bash
# ビルドとデプロイ
gcloud run deploy realtime-notify \
  --source . \
  --region asia-northeast1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "GCP_PROJECT_ID=$PROJECT_ID,PUBSUB_TOPIC=notifications,PUBSUB_SUBSCRIPTION=notifications-sub"
```

### 4. （オプション）Push型サブスクリプションの設定

Cloud RunのURLを取得後、Push型サブスクリプションを設定できます：

```bash
# Cloud RunのURLを取得
CLOUD_RUN_URL=$(gcloud run services describe realtime-notify \
  --region asia-northeast1 \
  --format='value(status.url)')

# Push型サブスクリプション作成
gcloud pubsub subscriptions create notifications-push \
  --topic=notifications \
  --push-endpoint="${CLOUD_RUN_URL}/pubsub/push"
```

## API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/events` | SSE接続（リアルタイム通知受信） |
| POST | `/notify` | 通知送信（Pub/Sub経由） |
| POST | `/pubsub/push` | Pub/Sub Pushエンドポイント |
| GET | `/clients` | 接続中クライアント一覧 |
| GET | `/health` | ヘルスチェック |

## 通知送信例

### curlで通知送信

```bash
# ローカル
curl -X POST http://localhost:8080/notify \
  -H "Content-Type: application/json" \
  -d '{"title":"テスト","message":"こんにちは！","type":"success"}'

# Cloud Run
curl -X POST https://your-service-url.run.app/notify \
  -H "Content-Type: application/json" \
  -d '{"title":"テスト","message":"こんにちは！","type":"info"}'
```

### gcloud CLIでPub/Subに直接送信

```bash
gcloud pubsub topics publish notifications \
  --message='{"title":"GCPから","message":"Pub/Sub経由の通知です","type":"warning"}'
```

## 通知タイプ

- `info` - 情報（青）
- `success` - 成功（緑）
- `warning` - 警告（黄）
- `error` - エラー（赤）

## トラブルシューティング

### Pub/Subに接続できない

1. `GOOGLE_APPLICATION_CREDENTIALS`が設定されているか確認
2. サービスアカウントに`Pub/Sub 編集者`権限があるか確認
3. プロジェクトIDが正しいか確認

### Cloud Runで動作しない

1. ログを確認: `gcloud run services logs read realtime-notify`
2. 環境変数が正しく設定されているか確認
3. ヘルスチェック: `curl https://your-url/health`
