/**
 * gemini-client.js
 * ---------------------------------------------------------
 * Gemini APIとの通信のみを担当する。プロンプト内容やUIロジックは持たない。
 * responseSchemaでJSON構造を強制し、想定外の形式が返ってきた場合は
 * 呼び出し側（app.js）でエラーとして扱えるようにする。
 * ---------------------------------------------------------
 */

const GeminiClient = (() => {

  const ISSUES_SCHEMA = {
    type: "object",
    properties: {
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string" },
            original: { type: "string" },
            suggested: { type: "string" },
            reason: { type: "string" },
            index: { type: "integer" },
            question: { type: "string" },
            actionOnPublish: { type: "boolean" }
          },
          required: ["category", "original", "reason"]
        }
      }
    },
    required: ["issues"]
  };

  const TITLES_SCHEMA = {
    type: "object",
    properties: {
      titles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            basis: { type: "string" },
            priorityMatched: { type: "string" }
          },
          required: ["text"]
        }
      }
    },
    required: ["titles"]
  };

  /**
   * HTTPヘッダーの値はISO-8859-1（Latin-1）の範囲でなければならない。
   * IMEオンでの入力・貼り付けや、他アプリからのコピペで全角文字や
   * ゼロ幅文字が紛れ込むと、fetchがこの範囲外の文字を拒否してエラーになる。
   * ここで正規化・除去・検証を行い、原因不明のTypeErrorではなく
   * 分かりやすいエラーメッセージを返せるようにする。
   */
  function toHeaderSafeAscii(value, label) {
    let v = String(value == null ? "" : value)
      .normalize("NFKC")                         // 全角英数字・記号を半角に正規化
      .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "") // ゼロ幅文字・BOM・ノーブレークスペース除去
      .trim();
    if (/[^\x00-\xFF]/.test(v)) {
      throw new Error(
        `${label}に全角文字や日本語など、通信ヘッダーで使用できない文字が含まれています。` +
        `コピー元によって見えない文字が紛れ込むことがあるため、一度メモ帳等に貼り付けてから改めてコピーし直し、` +
        `IME（日本語入力）をオフにした状態で貼り付け直してみてください。`
      );
    }
    if (v.length === 0) {
      throw new Error(`${label}が空です。入力してください。`);
    }
    return v;
  }

  function extractJson(raw) {
    let s = String(raw).trim();
    s = s.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error("JSON部分が見つかりませんでした。モデルの応答:\n" + raw.slice(0, 500));
    }
    return JSON.parse(s.slice(start, end + 1));
  }

  /**
   * @param {string} apiKey
   * @param {string} model
   * @param {string} prompt
   * @param {"issues"|"titles"} schemaKind - 期待する出力スキーマ
   */
  async function call(apiKey, model, prompt, schemaKind = "issues") {
    const safeApiKey = toHeaderSafeAscii(apiKey, "APIキー");
    const safeModel = toHeaderSafeAscii(model, "モデル名");
    const schema = schemaKind === "titles" ? TITLES_SCHEMA : ISSUES_SCHEMA;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": safeApiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema
          }
        })
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `APIエラー（${res.status}）: ${errText.slice(0, 400)}\n\n` +
        `※404の場合はモデル名が廃止されている可能性があります。エラー本文中の推奨モデル名に「モデル」欄のvalue値を書き換えてください。`
      );
    }
    const json = await res.json();
    const raw = json?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    if (!raw) throw new Error("モデルから応答テキストを取得できませんでした。");
    return extractJson(raw);
  }

  return { call };
})();