/**
 * image-editor.js
 * ---------------------------------------------------------
 * マニュアル③「画像編集」をブラウザ内で完結させるツール。
 * クロップ・拡大縮小・ファイルサイズ調整・ファイル名生成はAI不使用（Canvas APIのみ）。
 * 背景ぼかしのみ、初回クリック時に軽量なセグメンテーションモデルをCDNから読み込んで使用する
 * （読み込み後はブラウザ内で完結。モデルへ画像を外部送信するわけではない）。
 * ---------------------------------------------------------
 */

const ImageEditor = (() => {

  /* ---------- 外部スクリプトの遅延読み込み（背景ぼかしを使う時だけ読み込む） ---------- */
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`ライブラリの読み込みに失敗しました: ${src}`));
      document.head.appendChild(s);
    });
  }

  let segmenterPromise = null;
  async function getSegmenter() {
    if (segmenterPromise) return segmenterPromise;
    segmenterPromise = (async () => {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-core@4.20.0/dist/tf-core.min.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-converter@4.20.0/dist/tf-converter.min.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgl@4.20.0/dist/tf-backend-webgl.min.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow-models/body-segmentation@1.0.2/dist/body-segmentation.min.js");
      return await bodySegmentation.createSegmenter(
        bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation,
        { runtime: "mediapipe", solutionPath: "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation" }
      );
    })();
    return segmenterPromise;
  }

  /* ---------- ファイル名自動生成（URL末尾5桁 + s/l） ---------- */
  function extractIdFromUrl(url) {
    const m = String(url || "").trim().match(/(\d{4,6})\/?$/);
    return m ? m[1] : "";
  }
  function buildFileName(id, kind) {
    const suffix = kind === "small" ? "s" : "l";
    return (id || "untitled") + suffix + ".jpg";
  }

  /* ---------- クロップ・パン・ズームを担当するステージ ---------- */
  class CropStage {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.img = null;
      this.scale = 1;
      this.baseScale = 1; // cover(=フレームを覆う最小倍率)を1.0として扱うための基準値
      this.offsetX = 0;
      this.offsetY = 0;
      this.frozen = false;
      this._bindEvents();
    }

    loadImage(img) {
      this.img = img;
      const { width: fw, height: fh } = this.canvas;
      this.baseScale = Math.max(fw / img.width, fh / img.height);
      this.scale = this.baseScale;
      this.offsetX = (fw - img.width * this.scale) / 2;
      this.offsetY = (fh - img.height * this.scale) / 2;
      this.frozen = false;
      this.render();
    }

    render() {
      const { ctx, canvas, img, scale, offsetX, offsetY } = this;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (img) ctx.drawImage(img, offsetX, offsetY, img.width * scale, img.height * scale);
      // 頭上の余白ガイド線はここでは描画しない。
      // ガイドはCSSオーバーレイ（.crop-guide）として表示専用に重ねる。
      // キャンバスのピクセルには画像そのものしか含めないことで、
      // 書き出し・背景ぼかし処理に線が写り込まないようにしている。
    }

    zoomAt(cx, cy, factor) {
      if (this.frozen || !this.img) return;
      const prevScale = this.scale;
      this.scale = Math.min(this.baseScale * 6, Math.max(this.baseScale * 0.3, this.scale * factor));
      this.offsetX = cx - (cx - this.offsetX) * (this.scale / prevScale);
      this.offsetY = cy - (cy - this.offsetY) * (this.scale / prevScale);
      this.render();
    }

    setZoomPercent(percent) {
      // percent: 20〜300（スライダーのUI値）。100% = baseScale（フレームを覆う最小倍率）
      if (!this.img) return;
      const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
      const targetScale = this.baseScale * (percent / 100);
      const factor = targetScale / this.scale;
      this.zoomAt(cx, cy, factor);
    }

    freeze() { this.frozen = true; }
    unfreeze() { this.frozen = false; }

    _bindEvents() {
      let dragging = false, lastX = 0, lastY = 0;
      const c = this.canvas;
      c.addEventListener("pointerdown", e => {
        if (this.frozen) return;
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        c.style.cursor = "grabbing";
      });
      window.addEventListener("pointerup", () => { dragging = false; c.style.cursor = "grab"; });
      c.addEventListener("pointermove", e => {
        if (!dragging || this.frozen) return;
        const rect = c.getBoundingClientRect();
        const scaleX = c.width / rect.width, scaleY = c.height / rect.height;
        this.offsetX += (e.clientX - lastX) * scaleX;
        this.offsetY += (e.clientY - lastY) * scaleY;
        lastX = e.clientX; lastY = e.clientY;
        this.render();
      });
      c.addEventListener("wheel", e => {
        if (this.frozen) return;
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (c.width / rect.width);
        const y = (e.clientY - rect.top) * (c.height / rect.height);
        this.zoomAt(x, y, e.deltaY < 0 ? 1.06 : 0.94);
      }, { passive: false });
    }
  }

  /* ---------- ブラシによる背景ぼかしの微調整（マスクの追加/削除に相当） ---------- */
  class BlurRefiner {
    constructor(outputCanvas, sharpCanvas, blurredCanvas) {
      this.outputCanvas = outputCanvas;
      this.ctxOut = outputCanvas.getContext("2d");
      this.sharpCanvas = sharpCanvas;
      this.blurredCanvas = blurredCanvas;
      this.mode = "reveal-sharp"; // "reveal-sharp"=くっきり戻す／"restore-blur"=ぼかしを戻す
      this.brushSize = 25;
      this.ctxOut.drawImage(blurredCanvas, 0, 0);
      this._bindEvents();
    }
    setMode(mode) { this.mode = mode; }
    setBrushSize(size) { this.brushSize = size; }
    _paintAt(x, y) {
      const src = this.mode === "reveal-sharp" ? this.sharpCanvas : this.blurredCanvas;
      this.ctxOut.save();
      this.ctxOut.beginPath();
      this.ctxOut.arc(x, y, this.brushSize, 0, Math.PI * 2);
      this.ctxOut.clip();
      this.ctxOut.drawImage(src, 0, 0);
      this.ctxOut.restore();
    }
    _bindEvents() {
      let painting = false;
      const c = this.outputCanvas;
      const toCanvasXY = e => {
        const rect = c.getBoundingClientRect();
        return [(e.clientX - rect.left) * (c.width / rect.width), (e.clientY - rect.top) * (c.height / rect.height)];
      };
      c.addEventListener("pointerdown", e => { painting = true; const [x, y] = toCanvasXY(e); this._paintAt(x, y); });
      window.addEventListener("pointerup", () => painting = false);
      c.addEventListener("pointermove", e => { if (painting) { const [x, y] = toCanvasXY(e); this._paintAt(x, y); } });
    }
  }

  /* ---------- 目標ファイルサイズへの自動圧縮 ---------- */
  function canvasToBlob(canvas, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  }
  function downscaleCanvas(canvas, factor) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(canvas.width * factor));
    c.height = Math.max(1, Math.round(canvas.height * factor));
    c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }
  async function compressToTargetKB(sourceCanvas, minKB, maxKB) {
    let workCanvas = sourceCanvas;
    for (let pass = 0; pass < 6; pass++) {
      let quality = 0.92, blob = await canvasToBlob(workCanvas, quality), iter = 0;
      while (iter++ < 12) {
        const kb = blob.size / 1024;
        if (kb >= minKB && kb <= maxKB) return { blob, canvas: workCanvas, quality };
        quality += (kb > maxKB) ? -0.06 : 0.04;
        quality = Math.min(0.97, Math.max(0.05, quality));
        blob = await canvasToBlob(workCanvas, quality);
        if (quality <= 0.06 && blob.size / 1024 > maxKB) break; // これ以上品質を下げても効果が薄い→縮小へ
      }
      if (blob.size / 1024 <= maxKB) return { blob, canvas: workCanvas, quality };
      workCanvas = downscaleCanvas(workCanvas, 0.88); // 品質だけでは収まらない場合は寸法を縮小して再挑戦
    }
    // 6回縮小しても収まらない場合は、直近の結果をそのまま返す（呼び出し側で警告表示する）
    const blob = await canvasToBlob(workCanvas, 0.5);
    return { blob, canvas: workCanvas, quality: 0.5, warning: true };
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  return {
    CropStage, BlurRefiner, getSegmenter,
    extractIdFromUrl, buildFileName,
    compressToTargetKB, downloadBlob, downscaleCanvas
  };
})();

/* ============================================================
   画面バインディング（DOM操作）
   ============================================================ */
(function bindImageEditorUI() {
  const canvas = document.getElementById("cropCanvas");
  if (!canvas) return; // このタブが存在しないページでは何もしない

  const fileInput = document.getElementById("imgFile");
  const urlInput = document.getElementById("recordUrl");
  const zoomSlider = document.getElementById("zoomSlider");
  const blurBtn = document.getElementById("blurBtn");
  const blurStatus = document.getElementById("blurStatus");
  const brushControls = document.getElementById("brushControls");
  const brushModeSel = document.getElementById("brushMode");
  const brushSizeInput = document.getElementById("brushSize");
  const exportBtn = document.getElementById("exportBtn");
  const exportStatus = document.getElementById("exportStatus");
  const exportResult = document.getElementById("exportResult");

  const TARGETS = {
    small: { w: 480, h: 480, minKB: 15, maxKB: 60 },   // マニュアル：小画像50KB前後
    large: { w: 480, h: 320, minKB: 30, maxKB: 110 }    // マニュアル：大画像100KB前後、3:2
  };

  function currentKind() {
    return document.querySelector('input[name="imgKind"]:checked').value;
  }

  let stage = null;
  let blurRefiner = null;
  let loadedImage = null;

  function setupCanvasForKind(kind) {
    const t = TARGETS[kind];
    canvas.width = t.w;
    canvas.height = t.h;
    canvas.style.cursor = "grab";
    stage = new ImageEditor.CropStage(canvas);
    if (loadedImage) stage.loadImage(loadedImage);
    blurRefiner = null;
    brushControls.style.display = "none";
    blurStatus.textContent = "";
    exportResult.innerHTML = "";
  }

  setupCanvasForKind(currentKind());

  document.querySelectorAll('input[name="imgKind"]').forEach(r => {
    r.addEventListener("change", () => setupCanvasForKind(currentKind()));
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      loadedImage = img;
      setupCanvasForKind(currentKind());
      zoomSlider.value = 100;
    };
    img.src = URL.createObjectURL(file);
  });

  zoomSlider.addEventListener("input", () => {
    if (stage) stage.setZoomPercent(Number(zoomSlider.value));
  });

  blurBtn.addEventListener("click", async () => {
    if (!loadedImage) { blurStatus.textContent = "先に画像を選択してください。"; return; }
    blurBtn.disabled = true;
    blurStatus.textContent = "背景ぼかしモデルを読み込み中…（初回のみ数十秒かかる場合があります）";
    try {
      // 現在のクロップ状態を「元画像（くっきり版）」として確定
      stage.freeze();
      const sharpCanvas = document.createElement("canvas");
      sharpCanvas.width = canvas.width; sharpCanvas.height = canvas.height;
      sharpCanvas.getContext("2d").drawImage(canvas, 0, 0);

      const segmenter = await ImageEditor.getSegmenter();
      blurStatus.textContent = "背景を解析中…";
      const people = await segmenter.segmentPeople(sharpCanvas);

      const blurredCanvas = document.createElement("canvas");
      blurredCanvas.width = canvas.width; blurredCanvas.height = canvas.height;
      await bodySegmentation.drawBokehEffect(
        blurredCanvas, sharpCanvas, people,
        0.5,  // foregroundThreshold
        9,    // backgroundBlurAmount
        3     // edgeBlurAmount
      );

      blurRefiner = new ImageEditor.BlurRefiner(canvas, sharpCanvas, blurredCanvas);
      brushControls.style.display = "flex";
      blurStatus.textContent = "完了。人物と判定された部分以外が自動でぼかされました。必要ならブラシで微調整してください。";
    } catch (err) {
      blurStatus.textContent = "背景ぼかしに失敗しました（" + (err.message || err) + "）。手動での背景処理に切り替えてください。";
      stage.unfreeze();
    } finally {
      blurBtn.disabled = false;
    }
  });

  brushModeSel.addEventListener("change", () => { if (blurRefiner) blurRefiner.setMode(brushModeSel.value); });
  brushSizeInput.addEventListener("input", () => { if (blurRefiner) blurRefiner.setBrushSize(Number(brushSizeInput.value)); });

  exportBtn.addEventListener("click", async () => {
    if (!loadedImage) { exportStatus.textContent = "先に画像を選択してください。"; return; }
    exportBtn.disabled = true;
    exportStatus.textContent = "指定サイズに調整中…";
    try {
      const kind = currentKind();
      const t = TARGETS[kind];
      const { blob, canvas: finalCanvas, warning } = await ImageEditor.compressToTargetKB(canvas, t.minKB, t.maxKB);
      const id = ImageEditor.extractIdFromUrl(urlInput.value);
      const filename = ImageEditor.buildFileName(id, kind);
      const kb = (blob.size / 1024).toFixed(1);

      ImageEditor.downloadBlob(blob, filename);
      exportResult.innerHTML = `<div class="result-block">
        <h3>書き出し結果</h3>
        <div class="${warning ? "issue" : "empty-ok"}">
          ファイル名: <strong>${filename}</strong>／サイズ: <strong>${kb}KB</strong>
          （目標: ${t.minKB}〜${t.maxKB}KB）
          ${warning ? "<br>※目標サイズ帯にうまく収まりませんでした。元画像の解像度が低い可能性があるため、目視で確認してください。" : ""}
        </div>
      </div>`;
      exportStatus.textContent = "ダウンロードしました。";
    } catch (err) {
      exportResult.innerHTML = `<div class="raw-error">${err.message || err}</div>`;
      exportStatus.textContent = "エラーが発生しました。";
    } finally {
      exportBtn.disabled = false;
    }
  });
})();
