import { VercelRequest, VercelResponse } from "@vercel/node";
import {
  messagingApi,
  validateSignature,
  WebhookEvent,
  TextMessage,
} from "@line/bot-sdk";
import Anthropic from "@anthropic-ai/sdk";

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const channelSecret = process.env.LINE_CHANNEL_SECRET!;

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const SYSTEM_PROMPT = `あなたはマルタ村プロジェクトのAIアシスタントです。川西市モルックドームを拠点としたコミュニティサービス群の開発をサポートしています。打ち合わせの決定事項の整理、技術的な質問への回答、プロジェクトの進捗管理を手伝ってください。

重要: 回答はLINEメッセージとして送信されます。LINEはMarkdownに対応していないため、**太字**、##見出し、- リスト、\`コード\`などのMarkdown記法は一切使わないでください。プレーンテキストのみで回答してください。箇条書きが必要な場合は「・」や「1.」を使ってください。`;

async function generateReply(userMessage: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock?.text ?? "すみません、応答を生成できませんでした。";
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify LINE signature
  const signature = req.headers["x-line-signature"] as string;
  const body = JSON.stringify(req.body);

  if (!validateSignature(body, channelSecret, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const events: WebhookEvent[] = req.body.events;

  await Promise.all(
    events.map(async (event) => {
      if (event.type !== "message" || event.message.type !== "text") {
        return;
      }

      const userMessage = event.message.text;
      const replyToken = event.replyToken;

      try {
        const replyText = await generateReply(userMessage);

        const message: TextMessage = {
          type: "text",
          text: replyText,
        };

        await lineClient.replyMessage({
          replyToken,
          messages: [message],
        });
      } catch (error) {
        console.error("Error processing message:", error);
      }
    })
  );

  return res.status(200).json({ status: "ok" });
}
