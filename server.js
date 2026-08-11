// 哲学喫茶アプリ バックエンドAPIサーバー
//
// 役割:
//   フロントエンド（アプリ.html / 将来のCapacitorアプリ）から
//   「どの哲学者と」「どんなモードで」「何を話したか」を受け取り、
//   システムプロンプトを組み立てて Anthropic API を呼び出し、
//   返答をフロントに返す。
//
// 重要: APIキーはこのサーバー側にのみ置く。フロントエンドやアプリの
//       バイナリに絶対に埋め込まないこと（漏洩するため）。
//
// 起動方法:
//   1) npm install
//   2) .env に ANTHROPIC_API_KEY=sk-ant-... を設定
//   3) npm start
//
// 動作確認（例）:
//   curl -X POST http://localhost:3000/api/chat \
//     -H "Content-Type: application/json" \
//     -d '{
//       "philosopherId": "sartre",
//       "mode": "casual",
//       "userTopic": "仕事",
//       "history": [],
//       "message": "最近、なんか流されてる気がするんだよね"
//     }'

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { buildSystemPrompt, MASTER_SYSTEM_PROMPT, formatUserProfileBlock, getToneBlock } = require("./promptBuilder");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6";

if (!ANTHROPIC_API_KEY) {
  console.warn(
    "⚠ 警告: 環境変数 ANTHROPIC_API_KEY が設定されていません。.env を確認してください。"
  );
}

// philosophers.json をメモリに読み込み、id -> データ の辞書を作る
const PHILOSOPHERS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "philosophers.json"), "utf-8")
);
const PHIL_BY_ID = Object.fromEntries(PHILOSOPHERS.map((p) => [p.id, p]));

const app = express();
app.use(cors()); // 開発中は全許可。本番ではフロントのオリジンに絞ること。
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// GET /api/philosophers
// フロントが61人分のデータを取得するためのエンドポイント。
// （現状はHTMLに直接埋め込んでいるが、将来的にはここから動的取得に切替可能）
// ---------------------------------------------------------------------------
app.get("/api/philosophers", (req, res) => {
  res.json(PHILOSOPHERS);
});

// ---------------------------------------------------------------------------
// POST /api/chat
// body: {
//   philosopherId: string | "master",
//   mode: "casual" | "gachi",
//   userTopic?: string,           // 会話冒頭のテーマ（任意）
//   history?: {role:"user"|"assistant", content:string}[],  // これまでの会話
//   message: string               // 今回のユーザー発言
// }
// ---------------------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { philosopherId, mode = "casual", toneMode = "standard", userTopic, userProfile, history = [], message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message は必須です。" });
    }
    if (mode !== "casual" && mode !== "gachi") {
      return res.status(400).json({ error: "mode は 'casual' か 'gachi' のみ対応です。" });
    }

    let systemPrompt;
    if (philosopherId === "master" || !philosopherId) {
      systemPrompt = MASTER_SYSTEM_PROMPT + "\n" + getToneBlock(toneMode) + formatUserProfileBlock(userProfile);
    } else {
      const philosopher = PHIL_BY_ID[philosopherId];
      if (!philosopher) {
        return res.status(404).json({ error: `哲学者ID '${philosopherId}' が見つかりません。` });
      }
      systemPrompt = buildSystemPrompt(philosopher, mode, userTopic, userProfile, toneMode);
    }

    const messages = [
      ...history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ];

    const reply = await callClaude(systemPrompt, messages);
    res.json({ reply });
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ error: "サーバー内部でエラーが発生しました。" });
  }
});

// ---------------------------------------------------------------------------
// Anthropic API 呼び出し（Node標準fetchを使用。追加SDK依存なし）
// ---------------------------------------------------------------------------
async function callClaude(systemPrompt, messages) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

// ---------------------------------------------------------------------------
// POST /api/summarize
// body: { transcript: string, toneMode?: string }  // 会話ログをテキスト化したもの
// 返り値: { question: string, insight: string, valueNoteText?: string }
// 「今日のまとめ」画面の「今日の問い」「気づき」をAIに要約してもらうためのエンドポイント。
// toneMode が 'explore'（価値観探究モード）の場合は、追加で valueNoteText
// （「価値観ノート」として保存できる少し長めの文章）も生成する。
// ---------------------------------------------------------------------------
const SUMMARY_SYSTEM_PROMPT = `あなたは対話ログを要約するアシスタントです。
これから、ユーザーが「哲学喫茶」というアプリでマスターや哲学者たちと交わした会話のログを渡します。
これを読んで、次のJSON形式で **JSONのみ** を出力してください（説明文・前置き・コードブロックの記法（\`\`\`）は一切つけないこと）。

{
  "question": "会話の中心にあった問いを、短く「」付きの一文でまとめたもの",
  "insight": "会話を通してユーザーが得られそうな気づきや視点の変化を、1〜2文でやさしくまとめたもの"
}

注意点:
- question, insight とも日本語で、簡潔に。
- ユーザー自身の言葉遣いのニュアンスを尊重すること。
- 会話が短い・浅い場合でも、無理にでも何かしら前向きな一言をひねり出すこと。
- 説教くさくならないこと。`;

const VALUE_SUMMARY_SYSTEM_PROMPT = `あなたは対話ログから「価値観ノート」を書き起こすアシスタントです。
これから、ユーザーが「哲学喫茶」というアプリで、自分の価値観について哲学者（マスターや各哲学者）と
深掘りする対話をしたログを渡します。これを読んで、次のJSON形式で **JSONのみ** を出力してください
（説明文・前置き・コードブロックの記法（\`\`\`）は一切つけないこと）。

{
  "question": "対話の中心にあったテーマを、短く「」付きの一文でまとめたもの",
  "insight": "対話を通して見えてきた、ユーザーが大事にしていそうなことを1〜2文でまとめたもの",
  "valueNoteText": "対話全体を踏まえて書く、少し長めの『価値観ノート』本文（3〜6文程度）。
    箇条書きではなく、ユーザー自身の言葉のニュアンスを活かした文章で書くこと。
    対話の中で繰り返し出てきたテーマ、意外な共通点、大事にしていそうな軸などを、
    決めつけすぎず『〜かもしれない』というトーンでまとめること。矛盾や複数の側面が
    見えた場合は、それも無理に一本化せず、そのまま書いてよい。"
}

注意点:
- 全て日本語で。
- 説教くさくならないこと。断定しすぎないこと。
- 会話が短い・浅い場合でも、無理にでも何かしら書き出すこと。`;

app.post("/api/summarize", async (req, res) => {
  try {
    const { transcript, toneMode } = req.body;
    if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
      return res.status(400).json({ error: "transcript は必須です。" });
    }

    const isExplore = toneMode === "explore";
    const systemPrompt = isExplore ? VALUE_SUMMARY_SYSTEM_PROMPT : SUMMARY_SYSTEM_PROMPT;

    const raw = await callClaude(systemPrompt, [
      { role: "user", content: transcript },
    ]);

    let parsed;
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // JSONとして読めなかった場合の保険（丸ごとinsightとして返す）
      parsed = { question: "", insight: raw.trim() };
    }
    res.json(parsed);
  } catch (err) {
    console.error("summarize error:", err);
    res.status(500).json({ error: "サーバー内部でエラーが発生しました。" });
  }
});

app.listen(PORT, () => {
  console.log(`哲学喫茶API サーバー起動: http://localhost:${PORT}`);
});
