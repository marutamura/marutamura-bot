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
const notionToken = process.env.NOTION_TOKEN!;
const notionPageId = process.env.NOTION_PAGE_ID!;

const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const NOTION_API = "https://api.notion.com/v1";
const NOTION_HEADERS = {
  Authorization: `Bearer ${notionToken}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

const SYSTEM_PROMPT = `あなたはマルタ村プロジェクトのNotionページを管理するパートナーAIです。
ユーザーからの質問にはNotionの内容を参照して答えてください。
修正・追加の依頼には、現在の内容を示した上で修正案を提案し、確認を取ってから実行してください。
実行後はNotionページのURLを添えて報告してください。
LINEはMarkdownに対応していないので**や##などの記号は使わないでください。`;

// --- Notion helpers ---

interface NotionBlock {
  id: string;
  type: string;
  text: string;
}

function extractText(richText: any[]): string {
  return richText?.map((t: any) => t.plain_text).join("") ?? "";
}

function blockToText(block: any): NotionBlock {
  const type: string = block.type;
  let text = "";

  const richTextTypes = [
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "bulleted_list_item",
    "numbered_list_item",
    "quote",
    "callout",
    "toggle",
  ];

  if (type === "to_do") {
    const checked = block.to_do.checked ? "完了" : "未完了";
    text = `[${checked}] ${extractText(block.to_do.rich_text)}`;
  } else if (richTextTypes.includes(type) && block[type]?.rich_text) {
    text = extractText(block[type].rich_text);
  } else if (type === "code" && block.code?.rich_text) {
    text = extractText(block.code.rich_text);
  } else if (type === "divider") {
    text = "---";
  } else {
    text = `(${type}ブロック)`;
  }

  return { id: block.id, type, text };
}

async function fetchAllBlocks(): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;

  do {
    const url = `${NOTION_API}/blocks/${notionPageId}/children?page_size=100${
      cursor ? `&start_cursor=${cursor}` : ""
    }`;
    const res = await fetch(url, { headers: NOTION_HEADERS });
    const data: any = await res.json();

    for (const block of data.results ?? []) {
      blocks.push(blockToText(block));
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

function formatBlocksForPrompt(blocks: NotionBlock[]): string {
  if (blocks.length === 0) return "(ページは空です)";
  return blocks.map((b) => `[${b.id}] (${b.type}) ${b.text}`).join("\n");
}

function getPageUrl(): string {
  return `https://www.notion.so/${notionPageId.replace(/-/g, "")}`;
}

async function appendBlocks(texts: string[]): Promise<void> {
  const children = texts.map((text) => ({
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: {
      rich_text: [{ type: "text" as const, text: { content: text } }],
    },
  }));

  await fetch(`${NOTION_API}/blocks/${notionPageId}/children`, {
    method: "PATCH",
    headers: NOTION_HEADERS,
    body: JSON.stringify({ children }),
  });
}

async function updateBlock(blockId: string, text: string): Promise<void> {
  const res = await fetch(`${NOTION_API}/blocks/${blockId}`, {
    headers: NOTION_HEADERS,
  });
  const block: any = await res.json();
  const type: string = block.type;

  await fetch(`${NOTION_API}/blocks/${blockId}`, {
    method: "PATCH",
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      [type]: {
        rich_text: [{ type: "text", text: { content: text } }],
      },
    }),
  });
}

async function deleteBlock(blockId: string): Promise<void> {
  await fetch(`${NOTION_API}/blocks/${blockId}`, {
    method: "DELETE",
    headers: NOTION_HEADERS,
  });
}

// --- Claude tool definitions ---

const tools: Anthropic.Messages.Tool[] = [
  {
    name: "append_to_page",
    description:
      "Notionページの末尾にテキストを追加する。各要素が1つの段落ブロックになる。",
    input_schema: {
      type: "object" as const,
      properties: {
        texts: {
          type: "array",
          items: { type: "string" },
          description: "追加するテキストの配列",
        },
      },
      required: ["texts"],
    },
  },
  {
    name: "update_block",
    description:
      "指定したブロックのテキストを更新する。block_idはNotionページの内容から取得できる。",
    input_schema: {
      type: "object" as const,
      properties: {
        block_id: { type: "string", description: "更新するブロックのID" },
        text: { type: "string", description: "新しいテキスト" },
      },
      required: ["block_id", "text"],
    },
  },
  {
    name: "delete_block",
    description: "指定したブロックを削除する。",
    input_schema: {
      type: "object" as const,
      properties: {
        block_id: { type: "string", description: "削除するブロックのID" },
      },
      required: ["block_id"],
    },
  },
];

async function executeTool(name: string, input: any): Promise<string> {
  try {
    switch (name) {
      case "append_to_page":
        await appendBlocks(input.texts);
        return `追加完了。ページURL: ${getPageUrl()}`;
      case "update_block":
        await updateBlock(input.block_id, input.text);
        return `更新完了。ページURL: ${getPageUrl()}`;
      case "delete_block":
        await deleteBlock(input.block_id);
        return `削除完了。ページURL: ${getPageUrl()}`;
      default:
        return `不明なツール: ${name}`;
    }
  } catch (error) {
    return `エラー: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// --- Main reply logic ---

async function generateReply(userMessage: string): Promise<string> {
  const blocks = await fetchAllBlocks();
  const notionContent = formatBlocksForPrompt(blocks);

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: `【Notionページの現在の内容】\n${notionContent}\n\n【ユーザーのメッセージ】\n${userMessage}`,
    },
  ];

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  // Tool use loop
  while (response.stop_reason === "tool_use") {
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await executeTool(block.name, block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "すみません、応答を生成できませんでした。";
}

// --- Vercel handler ---

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

  const signature = req.headers["x-line-signature"] as string;
  const body = JSON.stringify(req.body);

  if (!validateSignature(body, channelSecret, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const events: WebhookEvent[] = req.body.events;

  await Promise.all(
    events.map(async (event) => {
      if (event.type !== "message" || event.message.type !== "text") return;

      const userMessage = event.message.text;
      const replyToken = event.replyToken;

      try {
        const replyText = await generateReply(userMessage);
        const message: TextMessage = { type: "text", text: replyText };
        await lineClient.replyMessage({ replyToken, messages: [message] });
      } catch (error) {
        console.error("Error processing message:", error);
      }
    })
  );

  return res.status(200).json({ status: "ok" });
}
