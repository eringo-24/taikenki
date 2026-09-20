/* ============================================================
   app.js
   画面操作・プロンプト生成・rule-engineとAI結果の統合を担当。
   RULES / LITERAL_RULES は rules.js、決定的チェックは rule-engine.js、
   Gemini通信は gemini-client.js を参照。
   ============================================================ */

/* ---------- タブ切り替え ---------- */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}

/* ---------- APIキーの2タブ間同期 ----------
   画面には「2つのタブでAPIキーは共通です」と表示しているが、
   これまでapiKey1とapiKey2は別々のinputで同期されていなかったため、
   実際には片方に入力してももう片方には反映されない状態だった。ここで同期する。 */
(function syncPairedInputs(idA, idB) {
  const a = document.getElementById(idA);
  const b = document.getElementById(idB);
  if (!a || !b) return;
  a.addEventListener("input", () => { if (b.value !== a.value) b.value = a.value; });
  b.addEventListener("input", () => { if (a.value !== b.value) a.value = b.value; });
})("apiKey1", "apiKey2");

/* ============ 本文チェックタブ ============ */
const inputText = document.getElementById("inputText");
const charCount = document.getElementById("charCount");
inputText.addEventListener("input", () => {
  charCount.textContent = inputText.value.length + "文字";
});

// AIには「文脈判断が必要なもの」だけを依頼する（辞書・数字表記はrule-engineが別途保証）
function buildBodyJudgmentPrompt(text) {
  return `あなたは大学受験合格体験記サイトの一次チェック担当者です。以下のルールに基づき、入力された本文の問題点を指摘してください。

# 削除すべき内容
${RULES.deleteItems.map(s => "・" + s).join("\n")}

# 文体・表記ルール
${RULES.styleRules.map(s => "・" + s).join("\n")}

# 文脈判断が必要な言い換え（機械的な自動置換はできないため、あなたが文脈を見て判断すること）
${RULES.contextDependentWords.map(s => "・" + s).join("\n")}

# 注意事項
- NG講師名、コンテンツ名の表記統一、略語の言い換え、数字の全角/半角は、
  このプロンプトとは別のシステムが機械的に検出するため、あなたは指摘不要です。
  （二重に指摘しても構いませんが、優先度を下げてください）
- 確信が持てない指摘は無理に作らないでください。

# 入力本文
"""
${text}
"""

# 出力形式（重要）
- 必ずJSONのみを出力すること。前置き、説明文、コードブロックの記号は一切付けない。
- 問題が見つからない場合は issues を空配列にする。
- スキーマ：
{"issues":[{"category":"削除項目 | 文体表記 | 誤字脱字 | 重複 | 矛盾","original":"該当箇所の原文抜粋","suggested":"修正案（削除の場合は空文字でよい）","reason":"指摘理由の説明（1文）"}]}`;
}

function buildTitlePrompt(text) {
  return `あなたは大学受験合格体験記サイトのタイトル付け担当者です。以下のルールに基づき、入力された本文からタイトル案を5つ作成してください。

# タイトル作成ルール
${RULES.titleRules.format}

# 優先順位（上から優先。内容が複数の優先項目にまたがる場合は最も優先度が高いものを基準にする）
${RULES.titleRules.priority.map((s, i) => (i + 1) + ". " + s).join("\n")}

# 注意事項
- タイトル中の数字表記（全角/半角）はこの後システム側で自動補正されるため、気にせず自然に書いてください。

# 入力本文
"""
${text}
"""

# 出力形式（重要）
- 必ずJSONのみを出力すること。前置き、説明文、コードブロックの記号は一切付けない。
- スキーマ：
{"titles":[{"text":"タイトル案","basis":"本文中のどの部分を根拠にしたか","priorityMatched":"該当する優先項目の要約"}]}`;
}

function renderIssueRow(it) {
  const fix = it.suggested && String(it.suggested).trim().length > 0
    ? `<span class="arrow">→</span><span class="fix">${escapeHtml(it.suggested)}</span>`
    : `<span class="arrow">→</span><span class="fix">${it.actionOnPublish ? "掲載するチェックを外す" : "削除を検討"}</span>`;
  const srcLabel = it.source === "rule-engine" ? "ルールエンジン（確実）" : "AI判断";
  const qLine = it.question ? `<div class="q">Q${it.index != null ? it.index + 1 : "?"}：${escapeHtml(it.question)}</div>` : "";
  return `<div class="issue ${it.actionOnPublish ? "warn-type" : ""}">
    <span class="cat">${escapeHtml(it.category || "指摘")}</span><span class="src ${it.source}">${srcLabel}</span>
    ${qLine}
    <div><span class="orig">${escapeHtml(it.original || "")}</span>${fix}</div>
    <div class="reason">${escapeHtml(it.reason || "")}</div>
  </div>`;
}

function renderIssues(containerEl, issues, emptyMessage) {
  if (issues.length === 0) {
    containerEl.innerHTML = `<div class="result-block"><h3>結果</h3><div class="empty-ok">${emptyMessage}</div></div>`;
    return;
  }
  const ruleCount = issues.filter(i => i.source === "rule-engine").length;
  const aiCount = issues.length - ruleCount;
  const rows = issues.map(renderIssueRow).join("");
  containerEl.innerHTML = `<div class="result-block">
    <h3>指摘事項（${issues.length}件／うちルールエンジン ${ruleCount}件・AI判断 ${aiCount}件）</h3>
    ${rows}
  </div>`;
}

document.getElementById("runBtn").addEventListener("click", async () => {
  const apiKey = document.getElementById("apiKey2").value.trim();
  const model = document.getElementById("model2").value;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const text = inputText.value.trim();
  const statusEl = document.getElementById("statusText");
  const runBtn = document.getElementById("runBtn");
  const resultsEl = document.getElementById("results");

  resultsEl.innerHTML = "";
  if (!apiKey) { statusEl.textContent = "APIキーを入力してください。"; return; }
  if (!text) { statusEl.textContent = "本文を入力してください。"; return; }

  runBtn.disabled = true;
  statusEl.textContent = "チェック中…";
  try {
    if (mode === "proof") {
      // 1) 決定的ルール（数字表記・NG講師名・表記統一）は必ずローカルで実行
      const ruleIssues = RuleEngine.runDeterministicChecks(text);
      // 2) AIには判断が必要な項目だけを依頼
      const aiRaw = await GeminiClient.call(apiKey, model, buildBodyJudgmentPrompt(text), "issues");
      const aiIssuesRaw = RuleEngine.validateIssuesShape(aiRaw);
      // 3) AI出力にも数字幅ルールを強制適用してから統合
      const aiIssues = RuleEngine.enforceOnAiIssues(aiIssuesRaw);
      const merged = RuleEngine.mergeIssues(ruleIssues, aiIssues);
      renderIssues(resultsEl, merged, "ルールに明確に該当する問題は見つかりませんでした。目視での最終確認は必ず行ってください。");
    } else {
      const data = await GeminiClient.call(apiKey, model, buildTitlePrompt(text), "titles");
      const titles = Array.isArray(data.titles) ? data.titles : [];
      if (titles.length === 0) {
        resultsEl.innerHTML = `<div class="result-block"><h3>結果</h3><div class="empty-ok">タイトル案を生成できませんでした。本文が短すぎる可能性があります。</div></div>`;
      } else {
        const rows = titles.map((t, i) => {
          const safeText = RuleEngine.enforceOnText(t.text || ""); // 数字幅を最終強制
          return `<div class="title-card">
            <span class="rank">案${i + 1}</span><strong>${escapeHtml(safeText)}</strong>
            <div class="reason" style="margin-top:6px;">根拠：${escapeHtml(t.basis || "")}／該当区分：${escapeHtml(t.priorityMatched || "")}</div>
          </div>`;
        }).join("");
        resultsEl.innerHTML = `<div class="result-block"><h3>タイトル案</h3>${rows}</div>`;
      }
    }
    statusEl.textContent = "完了";
  } catch (err) {
    resultsEl.innerHTML = `<div class="result-block"><h3>エラー</h3><div class="raw-error">${escapeHtml(err.message || String(err))}</div></div>`;
    statusEl.textContent = "エラーが発生しました";
  } finally {
    runBtn.disabled = false;
  }
});

/* ============ アンケートチェックタブ ============ */
function parseSurveyDump(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.trim())
    .filter(l => l.length > 0 && l !== "アンケート結果");
  const records = [];
  let i = 0;
  while (i < lines.length) {
    const question = lines[i]; i++;
    const answerLines = [];
    while (i < lines.length && lines[i] !== "掲載する" && lines[i] !== "掲載しない") {
      answerLines.push(lines[i]); i++;
    }
    let published = null;
    if (i < lines.length) {
      published = (lines[i] === "掲載する");
      i++;
    }
    records.push({ question, answer: answerLines.join("\n"), published });
  }
  return records;
}

let lastParsedRecords = [];

document.getElementById("parseBtn").addEventListener("click", () => {
  const raw = document.getElementById("surveyInput").value;
  const previewEl = document.getElementById("surveyParsePreview");
  document.getElementById("surveyResults").innerHTML = "";
  if (!raw.trim()) {
    previewEl.innerHTML = `<div class="hint">貼り付け欄が空です。</div>`;
    document.getElementById("surveyRunBtn").disabled = true;
    return;
  }
  const records = parseSurveyDump(raw);
  lastParsedRecords = records;

  const rows = records.map((r, idx) => {
    const answerCell = r.answer.length > 0
      ? escapeHtml(r.answer).replace(/\n/g, "<br>")
      : `<span class="blank">（空欄）</span>`;
    return `<tr><td>${idx + 1}</td><td>${escapeHtml(r.question)}</td><td>${answerCell}</td></tr>`;
  }).join("");

  previewEl.innerHTML = `
    <table class="parsed">
      <thead><tr><th>#</th><th>質問</th><th>回答</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="parse-count">${records.length}件の項目に分割しました。内容が正しく分かれているか確認してから「② AIでチェック実行」を押してください。</div>
  `;
  document.getElementById("surveyRunBtn").disabled = records.length === 0;
});

// AIには「文脈判断が必要なもの」だけを依頼する（辞書・数字表記はrule-engineが別途保証）
function buildSurveyJudgmentPrompt(records) {
  const recordsJson = JSON.stringify(
    records.map((r, i) => ({ index: i, question: r.question, answer: r.answer })),
    null, 0
  );
  return `あなたは大学受験合格体験記サイトのアンケート回答チェック担当者です。以下のルールに基づき、各回答項目の問題点を指摘してください。

# アンケートチェックのルール
${RULES.surveyRules.map(s => "・" + s).join("\n")}

# 文脈判断が必要な言い換え（機械的な自動置換はできないため、あなたが文脈を見て判断すること）
${RULES.contextDependentWords.map(s => "・" + s).join("\n")}

# 注意事項
- NG講師名、コンテンツ名の表記統一、略語の言い換え、数字の全角/半角は、
  このプロンプトとは別のシステムが機械的に検出するため、あなたは指摘不要です。

# 入力データ（index, question, answerの配列。同じquestionが複数回登場する場合はindexで区別すること）
${recordsJson}

# 出力形式（重要）
- 必ずJSONのみを出力すること。前置き、説明文、コードブロックの記号は一切付けない。
- 問題がない項目は出力に含めない（issuesは問題のある項目のみ）。
- 空欄（answerが空文字）の項目は、削除すべき内容が残っているわけではないので、原則issuesに含めない。
- スキーマ：
{"issues":[{"index":該当するindex番号,"question":"質問文","category":"削除対象 | 表記統一 | 重複 | 矛盾 | 文体誤字","original":"該当する回答の原文（全体でよい）","suggested":"修正案（削除を提案する場合は空文字でよい）","reason":"指摘理由（1文）","actionOnPublish":"掲載するチェックを外すことを推奨する場合はtrue、修正すれば掲載継続でよい場合はfalseをbooleanで"}]}`;
}

document.getElementById("surveyRunBtn").addEventListener("click", async () => {
  const apiKey = document.getElementById("apiKey1").value.trim();
  const model = document.getElementById("model1").value;
  const statusEl = document.getElementById("surveyStatus");
  const runBtn = document.getElementById("surveyRunBtn");
  const resultsEl = document.getElementById("surveyResults");

  resultsEl.innerHTML = "";
  if (!apiKey) { statusEl.textContent = "APIキーを入力してください。"; return; }
  if (lastParsedRecords.length === 0) { statusEl.textContent = "先に「①項目に分割してプレビュー」を実行してください。"; return; }

  runBtn.disabled = true;
  statusEl.textContent = "チェック中…";
  try {
    // 1) 各回答について決定的ルールをローカルで実行し、index/questionを付与
    const ruleIssues = [];
    lastParsedRecords.forEach((r, idx) => {
      RuleEngine.runDeterministicChecks(r.answer).forEach(issue => {
        ruleIssues.push({ ...issue, index: idx, question: r.question });
      });
    });

    // 2) AIには判断が必要な項目だけを依頼
    const aiRaw = await GeminiClient.call(apiKey, model, buildSurveyJudgmentPrompt(lastParsedRecords), "issues");
    const aiIssuesRaw = RuleEngine.validateIssuesShape(aiRaw);
    const aiIssues = RuleEngine.enforceOnAiIssues(aiIssuesRaw);

    // 3) 同一index内で重複するものを間引いて統合
    const byIndex = {};
    [...ruleIssues, ...aiIssues].forEach(it => {
      const key = it.index ?? -1;
      byIndex[key] = byIndex[key] || [];
      byIndex[key].push(it);
    });
    let merged = [];
    Object.keys(byIndex).forEach(key => {
      const group = byIndex[key];
      const ruleOnes = group.filter(g => g.source === "rule-engine");
      const aiOnes = group.filter(g => g.source === "ai");
      merged = merged.concat(RuleEngine.mergeIssues(ruleOnes, aiOnes));
    });
    merged.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    renderIssues(resultsEl, merged, "ルールに明確に該当する問題は見つかりませんでした。目視での最終確認は必ず行ってください。");
    if (merged.length > 0) {
      resultsEl.insertAdjacentHTML("beforeend",
        `<div class="hint">「掲載するチェックを外す」と表示された項目は、実際のチェックボックス状態を管理画面で確認したうえで操作してください（コピペからは判別できません）。</div>`);
    }
    statusEl.textContent = "完了";
  } catch (err) {
    resultsEl.innerHTML = `<div class="result-block"><h3>エラー</h3><div class="raw-error">${escapeHtml(err.message || String(err))}</div></div>`;
    statusEl.textContent = "エラーが発生しました";
  } finally {
    runBtn.disabled = false;
  }
});

/* ============ QA自己テストパネル（rule-engineの数字幅バグが再発していないかを常時確認） ============ */
(function renderSelfTest() {
  const el = document.getElementById("qaPanel");
  if (!el) return;
  const results = RuleEngine.selfTest();
  const passCount = results.filter(r => r.pass).length;
  const rows = results.map(r => `<tr>
    <td>${escapeHtml(r.input)}</td>
    <td>${escapeHtml(r.expected)}</td>
    <td>${escapeHtml(r.actual)}</td>
    <td class="${r.pass ? "qa-pass" : "qa-fail"}">${r.pass ? "OK" : "NG"}</td>
  </tr>`).join("");
  el.innerHTML = `
    <strong>ルールエンジン自己テスト：${passCount}/${results.length} OK</strong>
    <div class="hint">数字の全角/半角ルールなど、AIに依存せず必ず動作することを起動時に自動確認しています。</div>
    <table><thead><tr><th>入力</th><th>期待値</th><th>実際</th><th>判定</th></tr></thead><tbody>${rows}</tbody></table>
  `;
})();
