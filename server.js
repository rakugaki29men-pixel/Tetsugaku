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
//      OpenAI（Luna等）をテストする場合は OPENAI_API_KEY=sk-... と AI_PROVIDER=openai も設定
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// コスト比較のテスト用に、通常チャット（callClaude経由の部分）だけ、
// 使うAIプロバイダを環境変数で切り替えられるようにする。
// 'anthropic'（デフォルト） | 'openai'
// 検索機能（callClaudeWithSearch）や要約機能は、当面Anthropicのまま。
const AI_PROVIDER = process.env.AI_PROVIDER || "anthropic";
// 通常会話は応答速度優先の軽量モデル、ガチレスモードは今まで通りの標準モデルを使う。
const MODEL_CASUAL = "claude-haiku-4-5-20251001";
const MODEL_GACHI = "claude-sonnet-5";
// OpenAI側のテスト対象モデル。Lunaは最安の大量処理向け、Terraはその1つ上の
// バランス型（価格はClaude Sonnet 5とほぼ同水準）。価値観深掘り・ノートまとめの
// ような、要約系の重めのタスクをOpenAIに一本化するにあたり、この2つを比較する。
const MODEL_OPENAI_LUNA = "gpt-5.6-luna";
const MODEL_OPENAI_TERRA = "gpt-5.6-terra";

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

// フロントエンド(アプリ.html)を配信する
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "アプリ.html"));
});

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
    const { philosopherId, mode = "casual", toneMode = "standard", enableSearch, userTopic, userProfile, myPhilosophers, history = [], message, aiProvider } = req.body;

    // myPhilosophers はクライアント側で id 配列（例: 'sartre'）のまま保存されているので、
    // プロンプトに渡す前に日本語名へ変換しておく（IDのままだと会話の材料にしづらい）。
    const myPhilosophersNamed = myPhilosophers ? {
      aligned: (myPhilosophers.aligned || []).map((id) => PHIL_BY_ID[id]?.name).filter(Boolean),
      opposite: (myPhilosophers.opposite || []).map((id) => PHIL_BY_ID[id]?.name).filter(Boolean),
    } : null;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message は必須です。" });
    }
    if (mode !== "casual" && mode !== "gachi") {
      return res.status(400).json({ error: "mode は 'casual' か 'gachi' のみ対応です。" });
    }

    let systemPrompt;
    if (philosopherId === "master" || !philosopherId) {
      // マスターは基本的にセッションの温度感（厳しめ/丁寧など）の影響を受けず、
      // 常に同じ穏やかなキャラでいる。ただし「価値観探究モード（explore）」と
      // 「通常モード（standard）」だけは例外で、これらのモードでの具体的な
      // リードの仕方（質問攻めにしない、切り口を提示する、等）の指示そのものが
      // テツさんの振る舞いに直接関わるため、テツさんにもこのトーン指示を適用する。
      // ※以前は explore のみが対象になっており、standard 用に何度も指示を
      // 強化しても、実際にはテツさんに一切届いていなかった（根本原因）。
      const masterToneBlock = (toneMode === "explore" || toneMode === "standard")
        ? `\n\n${getToneBlock(toneMode)}` : "";
      // 実際にアプリに登録されている哲学者の名前一覧を渡し、[[suggest_philosopher]]
      // で名指しできるのはこの中からだけ、と縛る。この一覧を渡していなかった時、
      // モデルによっては（特にAnthropic以外のモデルで顕著だった）、アプリに実在
      // しない哲学者（例：マルティン・ブーバー）を、一般的な知識から提案して
      // しまう不具合があった。
      const rosterBlock = `\n\n# 紹介できる哲学者の一覧（このアプリに実在する人物のみ）\n` +
        `[[suggest_philosopher: 人物名]] で名指しできるのは、必ず次のリストにある人物に限る。\n` +
        `このリストにいない人物（一般的な知識にある実在の哲学者・思想家であっても）は、` +
        `絶対に名指しで紹介しないこと。\n` +
        PHILOSOPHERS.map((p) => p.name).join('、');
      systemPrompt = MASTER_SYSTEM_PROMPT + masterToneBlock + rosterBlock + formatUserProfileBlock(userProfile, myPhilosophersNamed);
    } else {
      const philosopher = PHIL_BY_ID[philosopherId];
      if (!philosopher) {
        return res.status(404).json({ error: `哲学者ID '${philosopherId}' が見つかりません。` });
      }
      systemPrompt = buildSystemPrompt(philosopher, mode, userTopic, userProfile, toneMode, myPhilosophersNamed);
    }

    const messages = [
      ...history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ];

    // 記事URLなど、話題の内容をAIに調べてもらいたい場合だけWeb検索を有効にする
    // （毎回検索するとコストがかさむので、フラグが立った時だけ）。
    // モデルについて：以前はガチレスモードだけSonnetを使う設計にしていたが、
    // 実際に使ってみて通常モードとの品質差がほとんど感じられなかったため、
    // 会話のたびに発生する通常チャットは、ガチレスモードでも一律Haikuを使う
    // ことにした（コストを大きく抑えられる）。要約系（/api/summarize等）は
    // 頻度が低く、複数の会話をまとめる高次の処理なので、引き続きSonnetを使う。
    const selectedModel = MODEL_CASUAL;
    const reply = enableSearch
      ? await callClaudeWithSearch(systemPrompt, messages, selectedModel, mode)
      : await callClaude(systemPrompt, messages, selectedModel, mode, aiProvider);
    res.json({ reply });
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ error: "サーバー内部でエラーが発生しました。" });
  }
});

// ---------------------------------------------------------------------------
// Anthropic API 呼び出し（Node標準fetchを使用。追加SDK依存なし）
// ---------------------------------------------------------------------------
async function callClaude(systemPrompt, messages, model, mode, providerOverride) {
  // AI_PROVIDER（サーバー全体のデフォルト）か、リクエストごとのproviderOverride
  //【テスト用】のどちらかがopenai系を指していれば、OpenAI側で応答する。
  // "openai"（後方互換のためLuna扱い）/"openai-luna"/"openai-terra" のいずれかを
  // 受け付け、価値観深掘り・ノートまとめのような要約系タスクでも、Luna/Terra
  // どちらのモデルで応答するかをテストできるようにしている。
  const provider = providerOverride || AI_PROVIDER;
  if (provider === "openai" || provider === "openai-luna") {
    return callOpenAI(systemPrompt, messages, mode, MODEL_OPENAI_LUNA);
  }
  if (provider === "openai-terra") {
    return callOpenAI(systemPrompt, messages, mode, MODEL_OPENAI_TERRA);
  }
  // ガチレスモードは「詳しく、深く」話す設計なので、日本語の文字数だと800トークンでは
  // 途中で切れてしまうことがある。ガチレスの時だけ上限を大きく取る。
  const maxTokens = mode === "gachi" ? 3000 : 800;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model || MODEL_CASUAL,
      max_tokens: maxTokens,
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
  const text = textBlock ? textBlock.text.trim() : "";
  return text || "ごめん、うまく言葉が出てこんかったわ。もう一回話しかけてくれる？";
}

// OpenAI（Luna/Terra）でのコスト・品質比較テスト用。Chat Completions形式で呼び出す。
// Anthropicの`system`＋`messages`という形と違い、OpenAIはsystemもmessages配列の
// 中の1要素（role: "system"）として渡す点に注意。
async function callOpenAI(systemPrompt, messages, mode, modelOverride) {
  const maxTokens = mode === "gachi" ? 3000 : 800;
  const openaiMessages = [
    { role: "system", content: systemPrompt },
    // Anthropic形式のmessages（role: "user"/"assistant", content: string）は
    // OpenAIのChat Completions形式ともほぼ互換なので、そのまま渡せる。
    ...messages,
  ];
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelOverride || MODEL_OPENAI_LUNA,
      // GPT-5.6系のモデルからは、Chat Completions APIでも`max_tokens`ではなく
      // `max_completion_tokens`を使う仕様に変わっている（従来の`max_tokens`は
      // 非対応パラメータとしてエラーになる）。
      max_completion_tokens: maxTokens,
      messages: openaiMessages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content?.trim() || "";
  return text || "ごめん、うまく言葉が出てこんかったわ。もう一回話しかけてくれる？";
}

// Web検索ツールを有効にした呼び出し。Web検索はAnthropic側（サーバーサイド）で
// 実行されるので、こちらで検索結果を受け渡すような複雑なやり取りは不要。
// レスポンスには複数のtextブロックが混ざることがあるので、それらを結合して返す。
// AIの返答からJSON部分だけを取り出す。
// 「JSONのみを出力して」と指示しても、web検索などツールを使った後の返答では
// 「〜見つかりました。以下がその内容です」のような前置き文が付いてしまうことがあり、
// 単にコードブロックの記号（```）を取り除くだけでは対応しきれない。
// そこで、```json〜``` のコードブロックがあればその中身を、無ければ最初の「{」から
// 最後の「}」までを取り出す、という順で頑丈にJSON部分を抽出する。
function extractJsonFromText(raw) {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return raw.slice(start, end + 1).trim();
  }
  return raw.trim();
}

async function callClaudeWithSearch(systemPrompt, messages, model, mode) {
  // 検索結果の読み込み分に加え、ガチレスの時はさらに多めに確保する
  const maxTokens = mode === "gachi" ? 3500 : 1500;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      // web_fetch はベータ機能のため、専用ヘッダーが必要
      "anthropic-beta": "web-fetch-2025-09-10",
    },
    body: JSON.stringify({
      model: model || MODEL_GACHI,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        // ユーザーが記事のURLを直接貼った場合、web_searchだけでは「検索」しかできず
        // そのURL自体を開けないため、web_fetchも併用してURLを直接読めるようにする。
        { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
  const combined = textBlocks.join("\n").trim();
  // 検索処理の途中で本文が空のまま返ってくることがあるため、
  // 空メッセージをそのまま返さず、分かりやすい保険の文言に差し替える。
  if (!combined) {
    return "ごめん、調べてる途中でうまく言葉にまとまらんかったわ。もう一回聞いてみてくれる？";
  }
  return combined;
}

// ---------------------------------------------------------------------------
// GET /api/trending-topics
// 返り値: { topics: [{ headline, summary }, ...] }
// 今話題になっているニュースをAIにWeb検索させ、哲学的な会話のきっかけになりそうな
// トピックを3つ返す。トピック選択画面の「今話題になってること」で使う。
// ---------------------------------------------------------------------------
const TRENDING_TOPICS_SYSTEM_PROMPT = `あなたは、日本語のニュースから今話題になっている出来事を調べるアシスタントです。
web検索を使って、直近話題になっているニュースや出来事を3つ探してください。
できれば、倫理・社会・生き方など、哲学的な会話のきっかけになりそうな話題を優先してください
（芸能ゴシップやスポーツの試合結果だけの話題は避け、社会的な意味合いのある話題を選ぶこと）。

見つけたら、次のJSON形式で **JSONのみ** を出力してください（説明文・前置き・コードブロックの記法は一切つけないこと）：

{
  "topics": [
    { "headline": "短い見出し（15〜20文字程度）", "summary": "1文程度の補足説明" }
  ]
}`;

app.get("/api/trending-topics", async (req, res) => {
  try {
    const raw = await callClaudeWithSearch(TRENDING_TOPICS_SYSTEM_PROMPT, [
      { role: "user", content: "今話題になっているニュースを3つ教えて。" },
    ]);
    let parsed;
    try {
      parsed = JSON.parse(extractJsonFromText(raw));
    } catch (e) {
      // JSONとして解釈できなかった場合。原因切り分けのため、AIの生の返答を
      // 一時的にそのまま含めて返す（原因が分かったら元に戻すこと）。
      console.error("trending-topics JSON parse failed. raw was:", raw);
      parsed = { topics: [], _debugParseFailed: true, _debugRaw: raw };
    }
    res.json(parsed);
  } catch (err) {
    console.error("trending-topics error:", err);
    res.status(500).json({ error: "サーバー内部でエラーが発生しました。", _debugMessage: String(err && err.message || err) });
  }
});

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
- question は必ず日本語で20〜30文字程度、どんなに長くても40文字を超えないこと。
  ユーザーの最初の発言や、会話中の特定の一文をそのまま長く引き写すのではなく、必ず
  「会話全体を通して、結局何についての話だったか」を、あなた自身の言葉で短く言い換えること。
- insight も日本語で、簡潔に（目安として60文字程度まで）。
- ユーザー自身の言葉遣いのニュアンスは尊重してよいが、文章をそのまま丸ごと使い回さない。
- 会話が短い・浅い場合でも、無理にでも何かしら前向きな一言を、短くひねり出すこと
  （長い引用でごまかさない）。
- 説教くさくならないこと。`;

const VALUE_SUMMARY_SYSTEM_PROMPT = `あなたは対話ログから「価値観ノート」を書き起こすアシスタントです。
これから、ユーザーが「テツトモ」というアプリで、自分の価値観について哲学者（テツさんや各哲学者）と
深掘りする対話をしたログを渡します。これを読んで、次のJSON形式で **JSONのみ** を出力してください
（説明文・前置き・コードブロックの記法（\`\`\`）は一切つけないこと）。

{
  "question": "対話の中心にあったテーマを、短く「」付きの一文でまとめたもの",
  "insight": "対話を通して見えてきた、ユーザーが大事にしていそうなことを1〜2文でまとめたもの",
  "valueNoteText": "対話全体を踏まえて書く、少し長めの『価値観ノート』本文（3〜6文程度）。
    箇条書きではなく、ユーザー自身の言葉のニュアンスを活かした文章で書くこと。
    対話の中で繰り返し出てきたテーマ、意外な共通点、大事にしていそうな軸などを、
    決めつけすぎず『〜かもしれない』というトーンでまとめること。矛盾や複数の側面が
    見えた場合は、それも無理に一本化せず、そのまま書いてよい。",
  "bookRecommendations": [
    { "title": "書名", "author": "著者名", "reason": "この対話のどんな部分と繋がりそうかを1文で" }
  ]
}

bookRecommendationsについての注意:
- 対話の中で見えてきたテーマ・興味・価値観と繋がりそうな本を2〜3冊。
- 哲学書に限らず、心理学・自然科学・経済学・歴史・小説・エッセイなど、テーマに合えば分野は問わない。
- 必ず実在する本だけを挙げること。存在するか自信が持てない本は挙げない。
  マイナーすぎる本より、実在が確実な有名作品を優先すること。
- 「なんとなく哲学っぽいから」で選ばない。対話の具体的な内容と結びつけること。

その他の注意点:
- 全て日本語で。
- 説教くさくならないこと。断定しすぎないこと。
- 会話が短い・浅い場合でも、無理にでも何かしら書き出すこと。`;

app.post("/api/summarize", async (req, res) => {
  try {
    const { transcript, toneMode, aiProvider } = req.body;
    if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
      return res.status(400).json({ error: "transcript は必須です。" });
    }

    const isExplore = toneMode === "explore";
    const systemPrompt = isExplore ? VALUE_SUMMARY_SYSTEM_PROMPT : SUMMARY_SYSTEM_PROMPT;

    const raw = await callClaude(systemPrompt, [
      { role: "user", content: transcript },
    ], MODEL_GACHI, undefined, aiProvider);

    let parsed;
    try {
      parsed = JSON.parse(extractJsonFromText(raw));
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

// 履歴画面で複数の会話を選んでまとめる「会話まとめノート」用。
// 個々の哲学者の主張の要約ではなく、ユーザー自身の見解・気づきの変遷を中心にまとめる。
const MULTI_SUMMARY_SYSTEM_PROMPT = `あなたは、ユーザーが哲学喫茶アプリで複数の哲学者たちと交わした会話をふりかえり、
それらをもとに「ユーザー自身の考えの記録」を1つのノートとしてまとめる役割です。

- 個々の哲学者が何を言ったかの要約ではなく、あくまで「ユーザーが何を考え、何に気づいたか」を中心にする
- 必ずユーザー自身の一人称視点で書く（例：「〜について考えた」「〜だと気づいた」「〜かもしれないと
  思った」）。テツさんや哲学者が話した内容をそのまま書き写したり、「〇〇さんはこう言った」のように
  相手の発言の要約で終わらせたりしない。相手の言葉は、あくまでユーザー自身がそれを受けて何を
  思ったかを書くための材料として使う。
- 複数の会話にまたがる共通のテーマ、考えの変化や深まりがあれば触れる
- 見出しや箇条書きを使わず、自然な地の文で300〜500字程度にまとめる
- マークダウン記法（#や*など）は使わない
- 「ですます」調ではなく、日記や手記のような、少し内省的な文体で書く
- JSONではなく、まとめた文章そのものだけを返す（前置きや後書きは不要）`;

app.post("/api/summarize-multi", async (req, res) => {
  try {
    const { conversations, aiProvider } = req.body;
    if (!Array.isArray(conversations) || conversations.length === 0) {
      return res.status(400).json({ error: "conversations は必須です。" });
    }
    const combined = conversations
      .map((c, i) => `【会話${i + 1}：${c.date || ""}・${c.topic || ""}】\n${c.transcript || ""}`)
      .join("\n\n---\n\n");

    const noteText = await callClaude(MULTI_SUMMARY_SYSTEM_PROMPT, [
      { role: "user", content: `以下の複数の会話から、ノートを書いてください。\n\n${combined}` },
    ], MODEL_GACHI, undefined, aiProvider);
    res.json({ noteText: noteText.trim() });
  } catch (err) {
    console.error("summarize-multi error:", err);
    res.status(500).json({ error: "サーバー内部でエラーが発生しました。" });
  }
});

app.listen(PORT, () => {
  console.log(`哲学喫茶API サーバー起動: http://localhost:${PORT}`);
});
