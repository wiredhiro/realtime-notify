require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PubSub } = require('@google-cloud/pubsub');

const app = express();
const PORT = process.env.PORT || 8080;

// GCP Pub/Sub設定
const projectId = process.env.GCP_PROJECT_ID;
const topicName = process.env.PUBSUB_TOPIC || 'notifications';
const subscriptionName = process.env.PUBSUB_SUBSCRIPTION || 'notifications-sub';

let pubsub;
let topic;
let subscription;

// Pub/Sub初期化
async function initPubSub() {
  try {
    pubsub = new PubSub({ projectId });

    // トピックの取得または作成
    try {
      [topic] = await pubsub.topic(topicName).get();
      console.log(`既存のトピックを使用: ${topicName}`);
    } catch (error) {
      if (error.code === 5) { // NOT_FOUND
        [topic] = await pubsub.createTopic(topicName);
        console.log(`トピックを作成: ${topicName}`);
      } else {
        throw error;
      }
    }

    // サブスクリプションの取得または作成
    try {
      [subscription] = await pubsub.subscription(subscriptionName).get();
      console.log(`既存のサブスクリプションを使用: ${subscriptionName}`);
    } catch (error) {
      if (error.code === 5) { // NOT_FOUND
        [subscription] = await topic.createSubscription(subscriptionName);
        console.log(`サブスクリプションを作成: ${subscriptionName}`);
      } else {
        throw error;
      }
    }

    // メッセージ受信リスナーを設定
    subscription.on('message', handlePubSubMessage);
    subscription.on('error', (error) => {
      console.error('Pub/Subエラー:', error);
    });

    console.log('Pub/Sub初期化完了');
    return true;
  } catch (error) {
    console.error('Pub/Sub初期化エラー:', error.message);
    console.log('ローカルモードで動作します（Pub/Subなし）');
    return false;
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 接続中のSSEクライアントを管理
const clients = new Map();

// Pub/Subからメッセージを受信した時の処理
function handlePubSubMessage(message) {
  try {
    const data = JSON.parse(message.data.toString());
    console.log('Pub/Subメッセージ受信:', data);

    const notification = {
      type: 'notification',
      data: {
        id: message.id,
        title: data.title || '通知',
        message: data.message,
        notificationType: data.type || 'info',
        timestamp: message.publishTime.toISOString(),
        source: 'pubsub'
      }
    };

    // 全SSEクライアントに配信
    broadcastToClients(notification);

    // メッセージを確認応答
    message.ack();
  } catch (error) {
    console.error('メッセージ処理エラー:', error);
    message.ack(); // エラーでも確認応答してキューから削除
  }
}

// 全クライアントにブロードキャスト
function broadcastToClients(notification) {
  let sentCount = 0;
  clients.forEach((client, clientId) => {
    try {
      client.write(`data: ${JSON.stringify(notification)}\n\n`);
      sentCount++;
    } catch (error) {
      console.error(`送信エラー (${clientId}):`, error);
      clients.delete(clientId);
    }
  });
  console.log(`${sentCount}件のクライアントに配信`);
}

// SSE接続エンドポイント
app.get('/events', (req, res) => {
  const clientId = req.query.clientId || `client_${Date.now()}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`data: ${JSON.stringify({
    type: 'connected',
    clientId,
    message: '接続しました',
    pubsubEnabled: !!subscription
  })}\n\n`);

  clients.set(clientId, res);
  console.log(`クライアント接続: ${clientId} (現在: ${clients.size})`);

  req.on('close', () => {
    clients.delete(clientId);
    console.log(`クライアント切断: ${clientId} (現在: ${clients.size})`);
  });
});

// 通知送信エンドポイント（Pub/Sub経由）
app.post('/notify', async (req, res) => {
  const { title, message, type = 'info' } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'メッセージは必須です' });
  }

  const notificationData = {
    title: title || '通知',
    message,
    type,
    timestamp: new Date().toISOString()
  };

  // Pub/Subが有効な場合はPub/Sub経由で送信
  if (topic) {
    try {
      const messageId = await topic.publishMessage({
        data: Buffer.from(JSON.stringify(notificationData))
      });
      console.log(`Pub/Subに送信: ${messageId}`);
      res.json({ success: true, messageId, via: 'pubsub' });
    } catch (error) {
      console.error('Pub/Sub送信エラー:', error);
      res.status(500).json({ error: 'Pub/Sub送信に失敗しました' });
    }
  } else {
    // Pub/Subが無効な場合は直接SSEで送信（ローカル開発用）
    const notification = {
      type: 'notification',
      data: {
        id: Date.now(),
        title: notificationData.title,
        message: notificationData.message,
        notificationType: notificationData.type,
        timestamp: notificationData.timestamp,
        source: 'direct'
      }
    };
    broadcastToClients(notification);
    res.json({ success: true, via: 'direct', sentCount: clients.size });
  }
});

// Pub/Sub Push エンドポイント（Cloud Runで使用）
app.post('/pubsub/push', (req, res) => {
  try {
    const pubsubMessage = req.body.message;
    if (!pubsubMessage) {
      return res.status(400).json({ error: 'Invalid Pub/Sub message' });
    }

    const data = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
    console.log('Pub/Sub Push受信:', data);

    const notification = {
      type: 'notification',
      data: {
        id: pubsubMessage.messageId,
        title: data.title || '通知',
        message: data.message,
        notificationType: data.type || 'info',
        timestamp: pubsubMessage.publishTime,
        source: 'pubsub-push'
      }
    };

    broadcastToClients(notification);
    res.status(200).send('OK');
  } catch (error) {
    console.error('Push処理エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 接続中のクライアント一覧
app.get('/clients', (req, res) => {
  const clientList = Array.from(clients.keys());
  res.json({ clients: clientList, count: clientList.length });
});

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connections: clients.size,
    pubsubEnabled: !!subscription,
    projectId: projectId || 'not set'
  });
});

// サーバー起動
async function start() {
  await initPubSub();

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║  GCP Pub/Sub リアルタイム通知サービス                  ║
╠══════════════════════════════════════════════════════╣
║  URL: http://localhost:${PORT}                          ║
║  Project: ${(projectId || 'not set').padEnd(40)}║
║  Topic: ${topicName.padEnd(43)}║
║  Pub/Sub: ${subscription ? '有効' : '無効（ローカルモード）'}                             ║
╠══════════════════════════════════════════════════════╣
║  エンドポイント:                                       ║
║  - GET  /events        SSE接続                        ║
║  - POST /notify        通知送信（Pub/Sub経由）         ║
║  - POST /pubsub/push   Pub/Sub Pushエンドポイント     ║
║  - GET  /clients       接続クライアント一覧            ║
║  - GET  /health        ヘルスチェック                  ║
╚══════════════════════════════════════════════════════╝
    `);
  });
}

start();
