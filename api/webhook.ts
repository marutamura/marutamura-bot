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
const githubToken = process.env.GITHUB_TOKEN!;
const githubOrg = "marutamura";

const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const NOTION_API = "https://api.notion.com/v1";
const NOTION_HEADERS = {
  Authorization: `Bearer ${notionToken}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

// アプリ名とGitHubリポジトリのマッピング
const APP_REPO_MAP: Record<string, string> = {
  "マルタギルド": "marta-guild",
  "満願寺御朱印帳": "manganji-stamp",
  "モノハブ": "monohub",
  "推し活": "oshi-katsu",
  "目標達成部": "mokuhyo-tassei-bu",
  "あちらさまからです": "achirasama",
  "ハッピー鑑定士": "happykantei",
  "満願寺どっち": "manganji-stamp",
};

const SYSTEM_PROMPT = `あなたはマルタ村プロジェクトのNotionページを管理するパートナーAIです。
ユーザーからの質問にはNotionの内容を参照して答えてください。
修正・追加の依頼には、現在の内容を示した上で修正案を提案し、確認を取ってから実行してください。
実行後はNotionページのURLを添えて報告してください。
LINEはMarkdownに対応していないので**や##などの記号は使わないでください。`;

const ISSUE_JUDGE_PROMPT = `You are a helper that analyzes user messages and returns JSON only.

Determine if the message is an app bug report, fix request, or feature request for one of these apps:
- マルタギルド
- 満願寺御朱印帳
- モノハブ
- 推し活
- 目標達成部
- あちらさまからです
- ハッピー鑑定士

If it IS a fix/bug/feature request, return ONLY this JSON (no other text):
{"is_issue":true,"app_name":"アプリ名","issue_title":"タイトル","issue_body":"詳細説明","manus_instruction":"Manusへの具体的な修正指示","confirm_message":"GitHubにIssueを作成しますか？\n\nアプリ: [アプリ名]\n内容: [タイトル]"}

If it is NOT a fix request, return ONLY this JSON (no other text):
{"is_issue":false}

IMPORTANT: Return raw JSON only. No markdown, no explanation, no code blocks.`;

// セッション管理（メモリ上、サーバーレスなので簡易的）
const pendingIssues: Record<string, {
  app_name: string;
  repo: string;
  issue_title: string;
  issue_body: string;
  manus_instruction: string;
  expires_at: number;
}> = {};

// --- GitHub helpers ---

async function createGitHubIssue(
  repo: string,
  title: string,
  body: string
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${githubOrg}/${repo}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API error: ${err}`);
  }

  const data: any = await res.json();
  return data.html_url;
}

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

// --- Issue判定 ---

async function judgeIfIssue(userMessage: string): Promise<any> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `${ISSUE_JUDGE_PROMPT}\n\nユーザーメッセージ: ${userMessage}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { is_issue: false };
  }
}

// --- Main reply logic ---

async function generateReply(userMessage: string, userId: string): Promise<string> {
  // 「はい」系の返答 → pending issueがあれば作成
  const yesPatterns = ["はい", "yes", "そうして", "お願い", "作って", "よろしく", "いいよ", "ええよ"];
  const noPatterns = ["いいえ", "no", "やめて", "キャンセル", "違う", "ちがう"];

  const isYes = yesPatterns.some((p) => userMessage.includes(p));
  const isNo = noPatterns.some((p) => userMessage.includes(p));

  if (isYes && pendingIssues[userId]) {
    const pending = pendingIssues[userId];
    // 期限切れチェック
    if (Date.now() > pending.expires_at) {
      delete pendingIssues[userId];
    } else {
      try {
        const issueUrl = await createGitHubIssue(
          pending.repo,
          pending.issue_title,
          pending.issue_body
        );
        delete pendingIssues[userId];

        return `Issue作成しました！\n\n${issueUrl}\n\n中さんへの指示文はこちら↓\n\n${pending.manus_instruction}`;
      } catch (error) {
        delete pendingIssues[userId];
        return `Issueの作成に失敗しました。${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  if (isNo && pendingIssues[userId]) {
    delete pendingIssues[userId];
    return "キャンセルしました。他に何かあれば聞いてください！";
  }

  // Issue判定
  const judgment = await judgeIfIssue(userMessage);

  if (judgment.is_issue) {
    const repo = APP_REPO_MAP[judgment.app_name];
    if (repo) {
      // pending issueとして保存（5分間有効）
      pendingIssues[userId] = {
        app_name: judgment.app_name,
        repo,
        issue_title: judgment.issue_title,
        issue_body: judgment.issue_body,
        manus_instruction: judgment.manus_instruction,
        expires_at: Date.now() + 5 * 60 * 1000,
      };
      return judgment.confirm_message;
    }
  }

  // 通常のNotion会話
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
      const userId = event.source.userId ?? "unknown";

      try {
        const replyText = await generateReply(userMessage, userId);
        const message: TextMessage = { type: "text", text: replyText };
        await lineClient.replyMessage({ replyToken, messages: [message] });
      } catch (error) {
        console.error("Error processing message:", error);
      }
    })
  );

  return res.status(200).json({ status: "ok" });
}
