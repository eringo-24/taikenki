/**
 * rule-engine.js
 * ---------------------------------------------------------
 * 「AIに指示しても従うとは限らない」ルールを、コード側で100%確実に処理するための
 * 決定的（deterministic）ロジック集。
 *
 * 設計方針：
 *   1. LLMへの指示は「絶対に守られる」ものではなく「守られやすくなる」だけ。
 *      100%守らせたいルールは、AIに頼らずコードで検出・修正する。
 *   2. AIの出力（suggested文字列）も無条件には信用せず、必ずこのファイルの
 *      正規化関数を通してから画面表示する（後段強制）。
 *   3. rule-engineが検出した指摘と、AIが検出した指摘は、由来（source）を
 *      明示して区別する。ユーザーはどちらの指摘か常に判別できる。
 * ---------------------------------------------------------
 */

const RuleEngine = (() => {

  const FULLWIDTH_DIGITS = "０１２３４５６７８９";
  const HALFWIDTH_DIGITS = "0123456789";

  /* ---------- 数字の全角・半角 ---------- */

  // 全角数字→半角数字（判定を統一するための前処理）
  function toHalfWidthDigits(str) {
    return String(str).replace(/[０-９]/g, ch => HALFWIDTH_DIGITS[FULLWIDTH_DIGITS.indexOf(ch)]);
  }

  // 半角数字→全角数字
  function toFullWidthDigits(str) {
    return String(str).replace(/[0-9]/g, ch => FULLWIDTH_DIGITS[HALFWIDTH_DIGITS.indexOf(ch)]);
  }

  /**
   * 「1桁の数字は全角、2桁以上は半角」ルールを強制的に適用する。
   * 全角/半角が混在していても、まず半角に統一してから桁数で判定し直すため、
   * 入力状態に関わらず必ず同じ結果になる（＝AIの出力ゆらぎを吸収する）。
   *
   * 小数点・カンマ区切りは1つの数値のまとまりとして桁数を判定する
   * （例：「1.5」は2桁扱い→半角のまま／「5」は1桁扱い→全角に変換）。
   */
  function normalizeNumberWidth(text) {
    if (!text) return text;
    const unified = toHalfWidthDigits(text);
    return unified.replace(/[0-9]+(?:[.,][0-9]+)*/g, (match) => {
      const digitOnly = match.replace(/[.,]/g, "");
      return digitOnly.length === 1 ? toFullWidthDigits(match) : match;
    });
  }

  /**
   * 数字表記ルール違反を検出する（AIが指摘し忘れても、こちらで必ず拾うための独立チェック）。
   * 「全角の2桁以上」「半角の単独1桁」の両方を違反として報告する。
   */
  function findNumberWidthViolations(text) {
    if (!text) return [];
    const violations = [];

    (text.match(/[０-９]{2,}/g) || []).forEach(m => {
      violations.push({
        category: "数字表記",
        original: m,
        suggested: normalizeNumberWidth(m),
        reason: "2桁以上の数字は半角にする必要があります（全角のまま残っています）",
        source: "rule-engine"
      });
    });

    // 半角の「単独1桁」を検出（前後が数字・小数点・カンマでないもの）
    const singleDigitRegex = /(?<![0-9０-９.,])[0-9](?![0-9０-９.,])/g;
    let m;
    while ((m = singleDigitRegex.exec(text)) !== null) {
      violations.push({
        category: "数字表記",
        original: m[0],
        suggested: toFullWidthDigits(m[0]),
        reason: "1桁の数字は全角にする必要があります（半角のまま残っています）",
        source: "rule-engine"
      });
    }
    return violations;
  }

  /* ---------- 連続する同一語句の重複検出（「志望校志望校」「講座講座」等） ---------- */

  /**
   * マニュアルの「よくある間違い」に明記されている「志望校志望校～/～講座講座のように
   * 連続している」パターンを機械的に検出する。2〜8文字の語句が直後にもう一度
   * 繰り返されている箇所を拾う。誤検知の可能性もゼロではないため、
   * suggestedは空にして「要確認」として扱う（自動修正はしない）。
   */
  function findRepeatedPhraseViolations(text) {
    if (!text) return [];
    const violations = [];
    const regex = /([^\s、。！？「」『』・]{2,8})\1/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      violations.push({
        category: "重複表現",
        original: m[0],
        suggested: "",
        reason: "同じ語句が連続して重複しています（コピペ時の重複ミスの可能性があります。意図的な表現であれば無視してください）",
        source: "rule-engine"
      });
    }
    return violations;
  }

  /* ---------- 辞書ベースの完全一致検出（NG講師名・表記統一・用語） ---------- */

  function findLiteralPairViolations(text, pairs, category, reasonSuffix) {
    if (!text) return [];
    const issues = [];
    pairs.forEach(([wrong, correct]) => {
      if (wrong && text.includes(wrong)) {
        issues.push({
          category,
          original: wrong,
          // AI由来の指摘だけでなく、辞書由来の指摘にも同じ後段強制をかける。
          // 辞書に半角/全角の誤りが混ざっていても、ここで必ず補正される。
          suggested: typeof correct === "string" ? normalizeNumberWidth(correct) : correct,
          reason: `${category}の統一ルールに一致しました${reasonSuffix || ""}`,
          source: "rule-engine"
        });
      }
    });
    return issues;
  }

  function findNgTeacherViolations(text) {
    if (!text) return [];
    return LITERAL_RULES.ngTeachers
      .filter(name => text.includes(name))
      .map(name => ({
        category: "講師名",
        original: name,
        suggested: "",
        reason: "NG講師名リストに一致しました。削除を検討してください",
        source: "rule-engine"
      }));
  }

  /**
   * 決定的ルール（数字表記・NG講師名・コンテンツ名・用語）をまとめて実行する。
   * このファイル単体でAI無しでも一次スクリーニングができる。
   */
  function runDeterministicChecks(text) {
    if (!text) return [];
    return [
      ...findNgTeacherViolations(text),
      ...findLiteralPairViolations(text, LITERAL_RULES.contentNamePairs, "コンテンツ名"),
      ...findLiteralPairViolations(text, LITERAL_RULES.wordPairs, "用語"),
      ...findNumberWidthViolations(text),
      ...findRepeatedPhraseViolations(text)
    ];
  }

  /* ---------- AI出力の後段強制（ここが今回のバグの直接対策） ---------- */

  /**
   * AIが返してきたissue配列に対し、suggestedフィールドを必ず数字幅ルールに従わせる。
   * 「プロンプトで指示したのに従われない」問題は、この後処理で構造的に解消する。
   */
  function enforceOnAiIssues(aiIssues) {
    if (!Array.isArray(aiIssues)) return [];
    return aiIssues.map(it => ({
      ...it,
      suggested: typeof it.suggested === "string" ? normalizeNumberWidth(it.suggested) : it.suggested,
      source: "ai"
    }));
  }

  /** タイトル案などAI生成テキスト全般にも同じ強制を適用する */
  function enforceOnText(text) {
    return normalizeNumberWidth(text || "");
  }

  /* ---------- ルールエンジン指摘とAI指摘の統合（重複を防ぐ） ---------- */

  /**
   * 同じ箇所を rule-engine と AI が両方指摘した場合、rule-engine側（＝確実な方）を優先し、
   * AI側の重複を間引く。originalテキストの一致（部分一致）で重複と判定する。
   *
   * 注意：数字表記の指摘（"1"や"５"のような1〜2文字の短い文字列）を重複判定のキーに
   * 使うと、AIが引用した長い文章にたまたま数字が含まれているだけで「重複」と誤判定し、
   * 本来無関係なAIの指摘（削除対象の指摘など）ごと消えてしまう。これを防ぐため、
   * 「数字表記」カテゴリと、2文字未満の短いoriginalは重複判定のキーから除外する。
   */
  function mergeIssues(ruleIssues, aiIssues) {
    const dedupKeys = ruleIssues.filter(r =>
      r.category !== "数字表記" && r.category !== "重複表現" &&
      typeof r.original === "string" && r.original.length >= 2
    );
    const deduped = aiIssues.filter(ai => {
      if (typeof ai.original !== "string" || !ai.original) return true;
      return !dedupKeys.some(rule =>
        rule.original && (ai.original.includes(rule.original) || rule.original.includes(ai.original))
      );
    });
    return [...ruleIssues, ...deduped];
  }

  /* ---------- AI応答の最低限のバリデーション ---------- */

  function validateIssuesShape(data) {
    if (!data || !Array.isArray(data.issues)) {
      throw new Error("AI応答の形式が不正です（issues配列がありません）");
    }
    return data.issues.filter(it => it && typeof it === "object");
  }

  /* ---------- 自己テスト（画面上のQAパネルから実行できる軽量アサーション） ---------- */

  function selfTest() {
    const cases = [
      { input: "5個の講座を受けました", expect: "５個の講座を受けました" },
      { input: "１２個の講座", expect: "12個の講座" }, // 全角2桁→半角
      { input: "1.5倍伸びた", expect: "1.5倍伸びた" }, // 小数はそのまま(2桁扱い)
      { input: "1番好きな講座", expect: "１番好きな講座" },
      { input: "モチベが上がった", expectIncludes: "モチベーション" },
      {
        // ②のバグ再発防止：辞書由来の提案自体も数字幅ルールに従っているか
        name: "一番→１番（辞書提案が全角になっているか）",
        customCheck: () => {
          const hits = findLiteralPairViolations("一番好きな講座です", LITERAL_RULES.wordPairs, "用語");
          const hit = hits.find(h => h.original === "一番");
          return { input: "一番好きな講座です", expected: "１番", actual: hit ? hit.suggested : "(検出なし)", pass: !!hit && hit.suggested === "１番" };
        }
      },
      {
        // ④の新規チェック：連続する同一語句の重複を検出できるか
        name: "連続重複「講座講座」の検出",
        customCheck: () => {
          const hits = findRepeatedPhraseViolations("この講座講座はとても良かったです");
          return { input: "この講座講座はとても良かったです", expected: "「講座講座」を検出", actual: JSON.stringify(hits.map(h => h.original)), pass: hits.some(h => h.original === "講座講座") };
        }
      },
      {
        // ③のバグ再発防止：数字表記の指摘が、無関係なAI指摘を誤って消さないか
        name: "mergeIssuesが数字混入だけでAI指摘を消さないか",
        customCheck: () => {
          const ruleIssues = findNumberWidthViolations("1年生の頃はサッカー部でした");
          const aiIssues = [{ category: "削除項目", original: "1年生の頃はサッカー部でしたが、後に退部しました", suggested: "", reason: "テスト用" }];
          const merged = mergeIssues(ruleIssues, aiIssues);
          const kept = merged.some(m => m.category === "削除項目");
          return { input: "(mergeIssuesの内部動作テスト)", expected: "AI指摘が保持される", actual: kept ? "保持された" : "消えてしまった", pass: kept };
        }
      }
    ];
    const results = cases.map(c => {
      if (c.customCheck) return c.customCheck();
      if (c.expect !== undefined) {
        const actual = normalizeNumberWidth(c.input);
        return { input: c.input, expected: c.expect, actual, pass: actual === c.expect };
      }
      const hits = findLiteralPairViolations(c.input, LITERAL_RULES.wordPairs, "用語");
      const pass = hits.some(h => h.suggested.includes(c.expectIncludes));
      return { input: c.input, expected: `${c.expectIncludes}を検出`, actual: JSON.stringify(hits), pass };
    });
    return results;
  }

  return {
    normalizeNumberWidth,
    findNumberWidthViolations,
    findNgTeacherViolations,
    findLiteralPairViolations,
    findRepeatedPhraseViolations,
    runDeterministicChecks,
    enforceOnAiIssues,
    enforceOnText,
    mergeIssues,
    validateIssuesShape,
    selfTest
  };
})();
