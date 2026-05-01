// uat-export.js
// HTML / PNG / PDF / PPTX エクスポート、スライドキャプチャ、編集可能 PPTX 構築。
// 外部 CDN ライブラリ (html2canvas / jsPDF / pptxgenjs / JSZip) を遅延ロード。
// index.html から切り出したエクスポート系モジュール。DOM 参照と UI ヘルパは init(ctx) で渡す。
//
// 依存: window.UAT_CODEC (uat-codec.js) — loadScript / URLS / extractTitle / formatBytes を使用
// 公開: window.UAT_EXPORT.init(ctx) → { captureSlides, exporters }
//
// ctx の必須フィールド:
//   frame            : <iframe> 要素
//   getCurrentHtml() : 現在表示中の HTML を取得 (currentHtml は変更される変数なので関数で渡す)
//   setStatus(msg)   : ステータスバー更新
//   setBusy(busy)    : ボタン無効化トグル (このモジュール内では使わないが、initで受けてもよい)
//   showProgress(c, t) : 進捗バー (total<=1 で非表示)
//   baseFilename()   : ダウンロード時のベースファイル名 (extractTitle 適用後)
//   downloadBlob(blob, filename) : ダウンロードトリガ
//   canvasToBlob(canvas, type)   : canvas.toBlob の Promise ラッパ
(() => {
  const C = window.UAT_CODEC;
  if (!C) {
    console.error('[url-to-artifact] uat-codec.js failed to load; uat-export.js cannot initialize');
    return;
  }
  const { loadScript, URLS, extractTitle, formatBytes } = C;

  // ============================================================
  // フレームヘルパ (init 内で frame に依存しない汎用部分は外に出す)
  // ============================================================
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const next2Frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  /** documentElement を html2canvas で撮影 */
  const snapshot = (doc, ww, hh) => window.html2canvas(doc.documentElement, {
    backgroundColor: '#ffffff',
    scale: 2,
    useCORS: true,
    logging: false,
    windowWidth: ww || doc.documentElement.scrollWidth,
    windowHeight: hh || doc.documentElement.scrollHeight
  });

  // ============================================================
  // Editable PPTX (Marpit) — extracts native PPTX text/image/table from DOM
  //   ここの関数群は frame 等の DOM 状態に依存しないため、init の外で定義しておく。
  // ============================================================

  /**
   * 任意の CSS 色文字列を 'RRGGBB' に変換する。透明 (alpha < 0.05) は null。
   * rgb / rgba は直接パースし、それ以外（oklch / lch / hsl / hwb / color() / hex /
   * 名前付きカラーなど）は canvas の fillStyle 正規化を介して rgb 文字列に揃えてから
   * 再パースする。これにより Tailwind CSS 4 などが既定で出力する oklch カラーも PPTX に
   * 反映される。以前は rgb() 以外をすべて null 扱いにしていたため、モダンアーティファクトで
   * PPTX の色が一斉に化ける事故が起きる。
   */
  const _colorNormCanvas = (() => {
    try { return document.createElement('canvas').getContext('2d'); }
    catch (e) { return null; }
  })();
  const RGB_RE = /^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*([\d.]+))?\)$/;
  const cssColorToHex = (color) => {
    if (!color) return null;
    const s = String(color);
    let m = s.match(RGB_RE);
    if (!m && _colorNormCanvas) {
      try {
        // 二段ベースライン方式で「不正な色」を判定する。
        //   問題: 1 つのベースライン (#01020a) との比較だけだと、ユーザ色がたまたま
        //         そのベースラインの正規化形 (例: '#01020a' そのもの、'rgb(1, 2, 10)') と
        //         一致した場合に「不正」と誤判定し、有効な色を null として捨ててしまう。
        //         これで PPTX 色が一部のスライドで反映されなくなる事故が起きうる。
        //   対策: 異なる 2 色のベースラインで順に試行する。s が片方のベースラインと
        //         衝突しても、もう片方では fillStyle が更新されるため確実に判定できる。
        //   なお fillStyle の読み返し形式はブラウザ依存で、CSS Color Level 4 以降では
        //   '#01020a' を代入しても 'rgb(1, 2, 10)' という文字列で返される可能性があるため、
        //   ハードコード文字列ではなく「代入直後に読み戻した値」をセンチネルとして使う。
        let norm = null;
        _colorNormCanvas.fillStyle = '#01020a';
        const sent1 = String(_colorNormCanvas.fillStyle);
        _colorNormCanvas.fillStyle = s;
        const norm1 = String(_colorNormCanvas.fillStyle);
        if (norm1 !== sent1) {
          norm = norm1;
        } else {
          // norm1 === sent1: s は不正 OR s の正規化形が偶然 sent1 と一致。
          // 別ベースラインで再試行し、更新されれば s は有効と確定する。
          _colorNormCanvas.fillStyle = '#fdfefe';
          const sent2 = String(_colorNormCanvas.fillStyle);
          _colorNormCanvas.fillStyle = s;
          const norm2 = String(_colorNormCanvas.fillStyle);
          if (norm2 !== sent2) norm = norm2;
        }
        if (norm) {
          m = norm.match(RGB_RE);
          if (!m) {
            const hexm = norm.match(/^#([0-9a-fA-F]{6})$/);
            if (hexm) return hexm[1].toUpperCase();
          }
        }
      } catch (e) { /* canvas 非対応・色解析失敗時は null フォールバック */ }
    }
    if (!m) return null;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (a < 0.05) return null;
    // 0..255 にクランプしてから 2 桁 hex に変換する。クランプを忘れると、
    // 'rgb(256, 0, 0)' のような範囲外値や 'rgba(255.7, 0, 0, 1)' のような小数値を
    // Math.round したときに 256 になり、(256).toString(16) === '100' と 3 文字 hex を吐いてしまう。
    // 結果として PPTX の色文字列が 7 文字 (例: '100FFFF') になり、pptxgenjs が無効な色として
    // 無視 / 例外を出す事故が起きる。Math.max/min で物理的に 0..255 に収め、NaN の場合も 0 として
    // 扱うことで、CSS パーサの実装差やフォントレンダリング仕様の揺れを含めてただしい hex に虃える。
    const toHex = (v) => {
      const n = Math.round(parseFloat(v));
      const clamped = isNaN(n) ? 0 : Math.max(0, Math.min(255, n));
      return clamped.toString(16).padStart(2, '0');
    };
    return (toHex(m[1]) + toHex(m[2]) + toHex(m[3])).toUpperCase();
  };

  /** font-family の最初のフォント名だけ取り出す（クォートを剥がす） */
  const fontFamilyFirst = (ff) => {
    if (!ff) return undefined;
    const first = String(ff).split(',')[0].replace(/['"]/g, '').trim();
    return first || undefined;
  };

  /**
   * DOM要素配下のテキストを書式付きランの配列として抽出（pptxgenjs addText形式）。
   * @param fontScale 与えると要素ごとに fontSize (pt) も run options に反映する
   */
  const extractRunsFromElement = (root, win, fontScale) => {
    const runs = [];
    const isInlineDsp = (d) => d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'inline-grid' || d === 'contents' || d === 'inline-table' || d === 'ruby';
    const clampFontPt = (v) => Math.max(6, Math.min(96, v));
    const walk = (node, ctx) => {
      if (node.nodeType === 3) {
        // HTML の空白圧縮ルールに合わせ、改行・連続空白を 1 個のスペースに畳む。
        // これをしないと `<h1>foo</h1>\n<p>bar</p>` の `\n` がランとして PPTX に出力され、
        // 見出し前後に意図しない大きな余白が出る。また、空白のみのランは、直前のランが
        // 既に空白で終わっている・改行 (breakLine) になっているときは捨てる。
        let t = node.textContent;
        if (!t) return;
        t = t.replace(/\s+/g, ' ');
        if (t === ' ') {
          const prev = runs[runs.length - 1];
          if (!prev || (prev.text && /\s$/.test(prev.text)) || prev.options.breakLine) return;
        }
        runs.push({ text: t, options: Object.assign({}, ctx) });
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
      if (tag === 'BR') {
        runs.push({ text: '', options: Object.assign({}, ctx, { breakLine: true }) });
        return;
      }
      const cs = win.getComputedStyle(node);
      // opacity=0 で隠している要素 (Tailwind の `opacity-0` クラス、トースト、ツールチップ等)
      // も PPTX には出さないようスキップする。これをしないとドロップダウンやホバー表示の
      // テキストがスライド本体に紛れ込む。
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
      // ブロックレベル要素の前にbreakLineを挿入（連続テキストを行で区切る、ルートはruns=0で自然にスキップ）
      if (!isInlineDsp(cs.display) && runs.length > 0 && !runs[runs.length - 1].options.breakLine) {
        runs[runs.length - 1].options = Object.assign({}, runs[runs.length - 1].options, { breakLine: true });
      }
      const newCtx = Object.assign({}, ctx);
      // font-weight / font-style: 親コンテキストが bold/italic でも、子に明示的な
      // `font-weight: normal` / `font-style: normal` が指定されている場合は解除する。
      // CSS の inherit ルールにより <strong> 配下の <span> は computed font-weight が
      // 700 のままになるので、何もしなければ親の太字が自然に維持される。
      // 明示的に normal を指定した子だけ computed が 400 (= fw < 600) になり、その時のみ
      // bold を false に倒すことで「<strong>foo <span style=font-weight:normal>bar</span></strong>」
      // のような部分非太字パターンを正しく PPTX に反映できる。italic も同様。
      // getComputedStyle().fontWeight は標準では数値文字列だが、古いブラウザ互換のために
      // 'bold' / 'normal' キーワードも検出する。
      const fw = parseInt(cs.fontWeight, 10);
      if ((!isNaN(fw) && fw >= 600) || /\bbold\b/i.test(cs.fontWeight) || tag === 'STRONG' || tag === 'B') {
        newCtx.bold = true;
      } else if (!isNaN(fw) && fw < 600) {
        newCtx.bold = false;
      }
      if (cs.fontStyle === 'italic' || cs.fontStyle === 'oblique' || tag === 'EM' || tag === 'I') {
        newCtx.italic = true;
      } else if (cs.fontStyle === 'normal') {
        newCtx.italic = false;
      }
      const tdline = (cs.textDecorationLine || cs.textDecoration || '');
      if (tdline.indexOf('underline') >= 0 || tag === 'U') newCtx.underline = { style: 'sng' };
      if (tdline.indexOf('line-through') >= 0 || tag === 'S' || tag === 'STRIKE' || tag === 'DEL') newCtx.strike = 'sngStrike';
      const c = cssColorToHex(cs.color);
      if (c) newCtx.color = c;
      if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') newCtx.fontFace = 'Consolas';
      if (tag === 'A') {
        // SVGの<a>は node.href が SVGAnimatedString になるため getAttribute を使う
        const href = node.getAttribute && node.getAttribute('href');
        if (href) {
          const url = (typeof node.href === 'string' && node.href) || href;
          // PowerPointで開いた際の安全性のため javascript: / data: / vbscript: スキームは除外
          if (!/^\s*(javascript|data|vbscript):/i.test(url)) {
            newCtx.hyperlink = { url };
          }
        }
      }
      // fontScale が渡された場合は、要素ごとの font-size も run options に反映する
      if (fontScale) {
        const fpx = parseFloat(cs.fontSize);
        if (!isNaN(fpx) && fpx > 0) newCtx.fontSize = clampFontPt(fpx * fontScale * 72);
      }
      Array.from(node.childNodes).forEach((ch) => walk(ch, newCtx));
    };
    walk(root, {});
    // 末尾の「不要な breakLine」を除去する。ブロック要素出口で付与された自動改行
    // （次のブロックとの間を区切るための何か）が、実際には次がないケース (例: <p>foo</p><p></p>
    // や <h1>title</h1> だけのテキストフレーム) ではテキスト末尾に意味のない空行が出る。
    // ただし <br> 由来の breakLineマーカー (text === '' && breakLine === true) はユーザ明示の改行意図なので
    // 保持し、text が空でない run に付いた末尾の自動 breakLine のみを除ける。
    if (runs.length > 0) {
      const last = runs[runs.length - 1];
      if (last.options.breakLine && last.text !== '') {
        const newOpts = Object.assign({}, last.options);
        delete newOpts.breakLine;
        last.options = newOpts;
      }
    }
    return runs;
  };

  /** <img>を可能ならdataURL化（同一オリジン or 既にdataURLの場合のみ成功） */
  const imgToDataURL = (img, doc) => {
    if (!img.src) return null;
    if (img.src.startsWith('data:')) return img.src;
    try {
      const c = doc.createElement('canvas');
      c.width = img.naturalWidth || img.width || 1;
      c.height = img.naturalHeight || img.height || 1;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } catch (e) {
      return null;
    }
  };

  // ============================================================
  // 公開: window.UAT_EXPORT.init(ctx) → { captureSlides, exporters }
  // ============================================================
  window.UAT_EXPORT = {
    init(ctx) {
      const { frame, getCurrentHtml, setStatus, showProgress, baseFilename, downloadBlob, canvasToBlob } = ctx;

      /** iframe ロード完了待ち（最大1.5秒のフォールバック） */
      const waitForFrame = () => new Promise((res) => {
        const ready = frame.contentDocument && frame.contentDocument.readyState === 'complete';
        if (ready) { res(); return; }
        let done = false;
        frame.addEventListener('load', () => { if (!done) { done = true; res(); } }, { once: true });
        setTimeout(() => { if (!done) { done = true; res(); } }, 1500);
      });

      /**
       * スライド構造を自動検出して順番に撮影。
       *   reveal.js    : Reveal.slide(h,v,f) で全スライドを巡回（transition: none）
       *   汎用<section>: body / main / .slides / .marpit 直下の <section>・.slide を display 切替で巡回
       *   <hr> 区切り  : body 直下の <hr> でグルーピングして display 切替で巡回（Markdown の --- 由来など）
       *   フォールバック : 全体1枚
       * 戻り値: { canvases: HTMLCanvasElement[], mode: 'reveal'|'sections'|'hr'|'single' }
       */
      const captureSlides = async () => {
        await loadScript(URLS.html2canvas);
        await waitForFrame();
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        if (!doc || !doc.documentElement) {
          throw new Error('iframe document is unavailable (sandbox may be too strict)');
        }

        // ---- reveal.js path ----
        const Reveal = win && win.Reveal;
        const hasReveal = Reveal
          && typeof Reveal.slide === 'function'
          && typeof Reveal.getSlides === 'function'
          && typeof Reveal.getIndices === 'function';
        if (hasReveal) {
          let slides = [];
          try { slides = Reveal.getSlides() || []; } catch (e) { slides = []; }
          if (slides.length > 1) {
            let origIdx = null;
            let origCfg = null;
            try { origIdx = Reveal.getIndices(); } catch (e) {}
            // 元の configure 値を保存して、export後に復元する（transitionを永遠にnoneにしたままにしない）。
            // undefined のキーは含めない: Reveal.configure は受け取ったオブジェクトをそのまま内部 config に
            // 適用するため、{transition: undefined} を渡すと「明示的に undefined にする」と解釈されて
            // ライブラリ既定値ではなく undefined が居座るバージョンがある。明示的に値が存在するキーだけを
            // 拾うことで、未指定だったオプションを誤って書き換える事故を防ぐ。
            try {
              if (typeof Reveal.getConfig === 'function') {
                const cfg = Reveal.getConfig() || {};
                origCfg = {};
                ['transition', 'backgroundTransition', 'controls', 'progress'].forEach((k) => {
                  if (cfg[k] !== undefined) origCfg[k] = cfg[k];
                });
              }
            } catch (e) {}
            try { Reveal.configure({ transition: 'none', backgroundTransition: 'none', controls: false, progress: false }); } catch (e) {}
            const ww = frame.clientWidth || doc.documentElement.scrollWidth;
            const hh = frame.clientHeight || doc.documentElement.scrollHeight;
            const canvases = [];
            try {
              for (let i = 0; i < slides.length; i++) {
                let idx = { h: i, v: 0 };
                try { idx = Reveal.getIndices(slides[i]) || idx; } catch (e) {}
                try { Reveal.slide(idx.h || 0, idx.v || 0, idx.f); } catch (e) {}
                await sleep(150);
                await next2Frames();
                showProgress(i + 1, slides.length);
                setStatus('exporting slide ' + (i + 1) + '/' + slides.length + '...');
                canvases.push(await snapshot(doc, ww, hh));
              }
            } finally {
              if (origCfg) {
                try { Reveal.configure(origCfg); } catch (e) {}
              }
              if (origIdx) {
                try { Reveal.slide(origIdx.h || 0, origIdx.v || 0, origIdx.f); } catch (e) {}
              }
            }
            return { canvases, mode: 'reveal' };
          }
        }

        // ---- 汎用セクション分割 ----
        const selectors = [
          'body > section',
          '.marpit > section',
          'body > .slide',
          'body > div.slide',
          'main > section',
          'main > .slide',
          '.slides > section'
        ];
        let sections = null;
        for (const sel of selectors) {
          const found = Array.from(doc.querySelectorAll(sel));
          if (found.length > 1) { sections = found; break; }
        }
        if (sections) {
          const original = sections.map(s => s.style.display);
          const ww = doc.documentElement.scrollWidth;
          const canvases = [];
          try {
            for (let i = 0; i < sections.length; i++) {
              sections.forEach((s, j) => { s.style.display = (i === j) ? '' : 'none'; });
              await next2Frames();
              showProgress(i + 1, sections.length);
              setStatus('exporting slide ' + (i + 1) + '/' + sections.length + '...');
              const visibleH = sections[i].scrollHeight || doc.documentElement.scrollHeight;
              canvases.push(await snapshot(doc, ww, visibleH));
            }
          } finally {
            sections.forEach((s, j) => { s.style.display = original[j]; });
          }
          return { canvases, mode: 'sections' };
        }

        // ---- <hr> 区切りスライド (Markdown→HTML 直変換などで body 直下に <hr> が並ぶケース) ----
        const allHrs = Array.from(doc.querySelectorAll('body > hr'));
        if (allHrs.length >= 2) {
          const SKIP_TAGS = ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','LINK','META','TITLE','BASE'];
          const allEls = Array.from(doc.body.children).filter(el => SKIP_TAGS.indexOf(el.tagName) < 0);
          const groups = [];
          let current = [];
          for (const el of allEls) {
            if (el.tagName === 'HR') {
              if (current.length > 0) { groups.push(current); current = []; }
            } else {
              current.push(el);
            }
          }
          if (current.length > 0) groups.push(current);

          if (groups.length > 1) {
            const original = allEls.map(el => el.style.display);
            const ww = doc.documentElement.scrollWidth;
            const canvases = [];
            try {
              for (let i = 0; i < groups.length; i++) {
                const visible = new Set(groups[i]);
                allEls.forEach(el => { el.style.display = visible.has(el) ? '' : 'none'; });
                await next2Frames();
                showProgress(i + 1, groups.length);
                setStatus('exporting slide ' + (i + 1) + '/' + groups.length + '...');
                const visibleH = doc.body.scrollHeight || doc.documentElement.scrollHeight;
                canvases.push(await snapshot(doc, ww, visibleH));
              }
            } finally {
              allEls.forEach((el, j) => { el.style.display = original[j]; });
            }
            return { canvases, mode: 'hr' };
          }
        }

        // ---- フォールバック：全体1枚 ----
        return { canvases: [await snapshot(doc)], mode: 'single' };
      };

      /**
       * Marpit形式の<section>群から、編集可能なネイティブPPTXを構築する。
       * 各<section>を1スライドに割り当て、配下の見出し・段落・リスト・表・画像・hrを
       * getBoundingClientRectで実測した位置・サイズでネイティブPPTX要素として配置する。
       * 文字色・背景色・フォントサイズ・太字・斜体・下線・取り消し線・リンクを反映。
       */
      const buildEditablePptx = async (pptx, sections, doc, win) => {
        const slideW = 13.333, slideH = 7.5;
        const HANDLED = ['H1','H2','H3','H4','H5','H6','P','UL','OL','BLOCKQUOTE','PRE','TABLE','IMG','HR','FIGCAPTION'];
        const clampPt = (v) => Math.max(6, Math.min(96, v));

        // 画像のロード完了を最大 3 秒待つ（dataURL化に naturalWidth>0 が必要）
        const allImgs = [];
        sections.forEach(s => Array.from(s.querySelectorAll('img')).forEach(img => allImgs.push(img)));
        if (allImgs.length > 0) {
          await Promise.all(allImgs.map(img => {
            if (img.complete && img.naturalWidth > 0) return Promise.resolve();
            return new Promise(res => {
              let done = false;
              const finish = () => { if (!done) { done = true; res(); } };
              img.addEventListener('load', finish, { once: true });
              img.addEventListener('error', finish, { once: true });
              setTimeout(finish, 3000);
            });
          }));
        }

        // Marpitなどがビューポートにフィットさせるために transform: scale() を使うと、
        // getBoundingClientRect は縮小後の値を返す一方で font-size の px 値は変わらず、
        // 計算した fontPt が過大になる。計測中は一時的に transform を解除する。
        const transformedEls = [];
        const savedTransforms = [];
        sections.forEach(s => {
          let el = s;
          while (el && el !== doc.documentElement) {
            if (win.getComputedStyle(el).transform !== 'none' && transformedEls.indexOf(el) < 0) {
              transformedEls.push(el);
              savedTransforms.push(el.style.transform);
            }
            el = el.parentElement;
          }
        });
        transformedEls.forEach(el => el.style.setProperty('transform', 'none', 'important'));

        const HANDLED_SELECTOR = HANDLED.map(t => t.toLowerCase()).join(',');
        const collectLeaves = (root) => {
          const leaves = [];
          const pushImgs = (el) => {
            Array.from(el.querySelectorAll('img')).forEach((img) => {
              const imgCs = win.getComputedStyle(img);
              // 上記同様 opacity=0 も隠し扱いとしてスキップ。
              if (imgCs.display !== 'none' && imgCs.visibility !== 'hidden' && parseFloat(imgCs.opacity) !== 0) leaves.push(img);
            });
          };
          const visit = (el) => {
            if (!el || el.nodeType !== 1) return;
            const cs = win.getComputedStyle(el);
            // opacity=0 要素もスキップして PPTX にゴースト要素が出ないようにする。
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
            const tag = el.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
            if (HANDLED.indexOf(tag) >= 0) {
              leaves.push(el);
              // 段落・見出し等の中に <img> がある場合は、IMG も独立 leaf として追加し、
              // ネイティブ画像として配置する（p の runs が空なら addText はスキップされる）
              if (tag !== 'IMG' && tag !== 'TABLE' && tag !== 'PRE') pushImgs(el);
              return;
            }
            // 非HANDLED要素 (div, header, footer など) の処理：
            // (a) 配下に HANDLED 要素があれば children を再帰探索する
            if (el.querySelector(HANDLED_SELECTOR)) {
              Array.from(el.children).forEach(visit);
              return;
            }
            // (b) HANDLED 配下なし。div だけで構成されたUI（カードグリッド・タイムライン等）に対応：
            //     テキストor画像を持つ要素の子が複数あれば、それぞれを再帰してflex/grid各セルを保つ
            const textOrImageChildren = Array.from(el.children).filter(c => {
              if (c.nodeType !== 1) return false;
              const ccs = win.getComputedStyle(c);
              if (ccs.display === 'none' || ccs.visibility === 'hidden' || parseFloat(ccs.opacity) === 0) return false;
              if (c.tagName === 'IMG') return true;
              const ct = c.textContent && c.textContent.trim();
              return !!ct || !!c.querySelector('img');
            });
            if (textOrImageChildren.length > 1) {
              textOrImageChildren.forEach(visit);
              return;
            }
            // (c) 子コンテンツが1つ以下 → 自身がテキストを持つなら leaf として配置
            const selfText = el.textContent && el.textContent.trim();
            if (selfText) {
              leaves.push(el);
              pushImgs(el); // コンテナ内の <img> は独立配置
              return;
            }
            // (d) 画像のみのコンテナ
            pushImgs(el);
          };
          Array.from(root.children).forEach(visit);
          return leaves;
        };

        const original = sections.map(s => s.style.display);
        try {
          for (let i = 0; i < sections.length; i++) {
            sections.forEach((s, j) => { s.style.display = (i === j) ? '' : 'none'; });
            await next2Frames();
            showProgress(i + 1, sections.length);
            setStatus('building slide ' + (i + 1) + '/' + sections.length + '...');

            const section = sections[i];
            const secRect = section.getBoundingClientRect();
            // 空・極小 section はスライドを作らずにスキップ（空白スライドと、fontScaleが爆発的に大きくなる事態を防止）
            if (secRect.width < 10 || secRect.height < 10) continue;
            const slide = pptx.addSlide();

            const secStyle = win.getComputedStyle(section);
            const secBg = cssColorToHex(secStyle.backgroundColor);
            if (secBg) slide.background = { color: secBg };

            const scaleX = slideW / secRect.width;
            const scaleY = slideH / secRect.height;
            const fontScale = scaleY;

            const leaves = collectLeaves(section);
            for (const el of leaves) {
              const r = el.getBoundingClientRect();
              const x = (r.left - secRect.left) * scaleX;
              const y = (r.top - secRect.top) * scaleY;
              const w = r.width * scaleX;
              const h = r.height * scaleY;
              if (w <= 0.01 || h <= 0.01) continue;

              const tag = el.tagName;
              const cs = win.getComputedStyle(el);
              const fontSizePx = parseFloat(cs.fontSize) || 16;
              const fontPt = clampPt(fontSizePx * fontScale * 72);
              const color = cssColorToHex(cs.color);
              const bgcolor = cssColorToHex(cs.backgroundColor);
              const fontFace = fontFamilyFirst(cs.fontFamily);
              const fwn = parseInt(cs.fontWeight, 10);
              const isBold = (!isNaN(fwn) && fwn >= 600) || tag === 'STRONG' || tag === 'B';
              const isItalic = cs.fontStyle === 'italic';
              const ta = cs.textAlign;
              const align = (ta === 'center') ? 'center'
                : (ta === 'right' || ta === 'end') ? 'right'
                : (ta === 'justify') ? 'justify'
                : 'left';

              if (tag === 'IMG') {
                const data = imgToDataURL(el, doc);
                if (data) {
                  // 画像が <a href="..."> の子孫である場合は、その親リンクを
                  // PPTX のクリッカブルハイパーリンクとして引き継ぐ。これをしないと、
                  // 「ロゴをクリックするとサイトに飛ぶ」「サムネイルをクリックすると詳細ページへ」
                  // のような典型的な構造が PPTX で死んでしまい、ユーザがスライド上で押しても
                  // 何も起こらない。javascript: / data: / vbscript: スキームは PowerPoint で開いたときの
                  // 安全性のため除外する (extractRunsFromElement の <a> 処理と同じポリシー)。
                  const opts = { data, x, y, w, h };
                  const parentA = el.closest && el.closest('a[href]');
                  if (parentA) {
                    const href = parentA.getAttribute('href');
                    if (href && !/^\s*(javascript|data|vbscript):/i.test(href)) {
                      const url = (typeof parentA.href === 'string' && parentA.href) || href;
                      opts.hyperlink = { url };
                    }
                  }
                  slide.addImage(opts);
                }
                continue;
              }
              if (tag === 'HR') {
                const lineColor = color || cssColorToHex(cs.borderTopColor) || '888888';
                slide.addShape('rect', {
                  x, y: y + h/2 - 0.01, w, h: 0.02,
                  fill: { color: lineColor },
                  line: { color: lineColor, width: 0 }
                });
                continue;
              }
              if (tag === 'TABLE') {
                const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
                  Array.from(tr.children).filter(cc => cc.tagName === 'TH' || cc.tagName === 'TD').map((td) => {
                    const tdcs = win.getComputedStyle(td);
                    const tdfill = cssColorToHex(tdcs.backgroundColor);
                    const tdcolor = cssColorToHex(tdcs.color);
                    const tdfsize = parseFloat(tdcs.fontSize) || fontSizePx;
                    const cellRuns = extractRunsFromElement(td, win, fontScale);
                    return {
                      // 空セルはスペース1つをプレースホルダーとして返す（pptxgenjsの表セルに text: [] を渡すと不安定）
                      text: cellRuns.length > 0 ? cellRuns : [{ text: ' ', options: {} }],
                      options: {
                        fill: tdfill ? { color: tdfill } : undefined,
                        color: tdcolor || undefined,
                        bold: td.tagName === 'TH' ? true : undefined,
                        fontSize: clampPt(tdfsize * fontScale * 72),
                        fontFace,
                        colspan: parseInt(td.getAttribute('colspan'), 10) > 1 ? parseInt(td.getAttribute('colspan'), 10) : undefined,
                        rowspan: parseInt(td.getAttribute('rowspan'), 10) > 1 ? parseInt(td.getAttribute('rowspan'), 10) : undefined
                      }
                    };
                  })
                ).filter(r => r.length > 0);
                if (rows.length > 0) {
                  slide.addTable(rows, { x, y, w, h, fontSize: fontPt, fontFace, color: color || undefined });
                }
                continue;
              }
              if (tag === 'UL' || tag === 'OL') {
                const items = Array.from(el.children).filter((cc) => cc.tagName === 'LI');
                if (items.length === 0) continue;
                const arr = [];
                items.forEach((li, idx) => {
                  const liRuns = extractRunsFromElement(li, win, fontScale);
                  if (liRuns.length === 0) liRuns.push({ text: ' ', options: {} });
                  for (let k = 0; k < liRuns.length; k++) {
                    if (k === liRuns.length - 1 && idx < items.length - 1) {
                      liRuns[k].options = Object.assign({}, liRuns[k].options, { breakLine: true });
                    }
                    arr.push(liRuns[k]);
                  }
                });
                slide.addText(arr, {
                  x, y, w, h,
                  fontSize: fontPt,
                  color: color || undefined,
                  bold: isBold || undefined,
                  italic: isItalic || undefined,
                  fontFace,
                  align,
                  valign: 'top',
                  bullet: tag === 'OL' ? { type: 'number' } : true,
                  fill: bgcolor ? { color: bgcolor } : undefined,
                  paraSpaceAfter: 4
                });
                continue;
              }
              if (tag === 'PRE') {
                const text = el.textContent || '';
                slide.addText(text, {
                  x, y, w, h,
                  fontSize: clampPt(fontPt * 0.9),
                  color: color || undefined,
                  fontFace: 'Consolas',
                  align: 'left',
                  valign: 'top',
                  fill: { color: bgcolor || 'F4F4F4' },
                  isTextBox: true
                });
                continue;
              }
              // h1-h6, p, blockquote, figcaption
              const runs = extractRunsFromElement(el, win, fontScale);
              if (runs.length === 0) continue;
              slide.addText(runs, {
                x, y, w, h,
                fontSize: fontPt,
                color: color || undefined,
                bold: isBold || undefined,
                italic: isItalic || undefined,
                fontFace,
                align,
                valign: 'top',
                fill: bgcolor ? { color: bgcolor } : undefined
              });
            }
          }
        } finally {
          sections.forEach((s, j) => { s.style.display = original[j]; });
          transformedEls.forEach((el, idx) => {
            const v = savedTransforms[idx];
            if (v) el.style.transform = v;
            else el.style.removeProperty('transform');
          });
        }
      };

      // ============================================================
      // Exporters
      // ============================================================
      const exporters = {
        html: async () => {
          const currentHtml = getCurrentHtml();
          const blob = new Blob([currentHtml], { type: 'text/html;charset=utf-8' });
          downloadBlob(blob, baseFilename() + '.html');
          setStatus('HTML saved');
        },

        png: async () => {
          setStatus('exporting PNG...');
          const { canvases, mode } = await captureSlides();
          // 単一 → 1枚のPNG、複数 → ZIPアーカイブ
          if (canvases.length === 1) {
            const blob = await canvasToBlob(canvases[0], 'image/png');
            downloadBlob(blob, baseFilename() + '.png');
            setStatus('PNG saved (' + formatBytes(blob.size) + ', mode=' + mode + ')');
            return;
          }
          await loadScript(URLS.jszip);
          const zip = new window.JSZip();
          const padLen = String(canvases.length).length;
          for (let i = 0; i < canvases.length; i++) {
            showProgress(i + 1, canvases.length);
            setStatus('packing PNG ' + (i + 1) + '/' + canvases.length + '...');
            const blob = await canvasToBlob(canvases[i], 'image/png');
            const idx = String(i + 1).padStart(padLen, '0');
            zip.file(baseFilename() + '-' + idx + '.png', blob);
          }
          const zipBlob = await zip.generateAsync({ type: 'blob' });
          downloadBlob(zipBlob, baseFilename() + '-png.zip');
          setStatus('PNG ZIP saved (' + canvases.length + ' images, ' + formatBytes(zipBlob.size) + ', mode=' + mode + ')');
        },

        pdf: async () => {
          setStatus('exporting PDF...');
          await loadScript(URLS.jspdf);
          const { canvases, mode } = await captureSlides();
          const { jsPDF } = window.jspdf;

          // 単一モード（通常のアーティファクト）
          // → 縦横比からA4の向きを決め、長辺方向にページ自動分割
          if (mode === 'single' && canvases.length === 1) {
            const c = canvases[0];
            const orient = c.width >= c.height ? 'landscape' : 'portrait';
            const pdf = new jsPDF({ orientation: orient, unit: 'pt', format: 'a4', compress: true });
            const pw = pdf.internal.pageSize.getWidth();
            const ph = pdf.internal.pageSize.getHeight();
            const isPortrait = orient === 'portrait';
            // 短辺をページに合わせる縮尺
            const scale = isPortrait ? pw / c.width : ph / c.height;
            const longCanvas = isPortrait ? c.height : c.width;     // 元キャンバスの長辺ピクセル
            const longPage = isPortrait ? ph : pw;                  // PDFページの長辺pt
            const longScaled = longCanvas * scale;                  // 長辺を縮尺後

            if (longScaled <= longPage + 0.5) {
              // 1ページに収まる → レターボックス
              const r = Math.min(pw / c.width, ph / c.height);
              const w = c.width * r;
              const h = c.height * r;
              pdf.addImage(c.toDataURL('image/png'), 'PNG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST');
              pdf.save(baseFilename() + '.pdf');
              setStatus('PDF saved (1 page, mode=single)');
            } else {
              // 長辺方向にページ分割
              const pageInCanvas = longPage / scale;
              const pageCount = Math.ceil(longCanvas / pageInCanvas);
              const slicer = document.createElement('canvas');
              if (isPortrait) slicer.width = c.width; else slicer.height = c.height;
              const sctx = slicer.getContext('2d');
              for (let i = 0; i < pageCount; i++) {
                const start = i * pageInCanvas;
                const sliceLen = Math.min(pageInCanvas, longCanvas - start);
                if (isPortrait) slicer.height = Math.ceil(sliceLen);
                else slicer.width = Math.ceil(sliceLen);
                sctx.fillStyle = '#ffffff';
                sctx.fillRect(0, 0, slicer.width, slicer.height);
                if (isPortrait) {
                  sctx.drawImage(c, 0, start, c.width, sliceLen, 0, 0, c.width, sliceLen);
                } else {
                  sctx.drawImage(c, start, 0, sliceLen, c.height, 0, 0, sliceLen, c.height);
                }
                if (i > 0) pdf.addPage('a4', orient);
                if (isPortrait) {
                  pdf.addImage(slicer.toDataURL('image/png'), 'PNG', 0, 0, pw, sliceLen * scale, undefined, 'FAST');
                } else {
                  pdf.addImage(slicer.toDataURL('image/png'), 'PNG', 0, 0, sliceLen * scale, ph, undefined, 'FAST');
                }
                showProgress(i + 1, pageCount);
                setStatus('rendering PDF page ' + (i + 1) + '/' + pageCount + '...');
              }
              pdf.save(baseFilename() + '.pdf');
              setStatus('PDF saved (' + pageCount + ' pages, mode=long-page-' + (isPortrait ? 'v' : 'h') + ')');
            }
            return;
          }

          // 複数スライド：1スライド = 1ページ（向きはキャンバス比で個別判定）
          const first = canvases[0];
          const firstOrient = first.width >= first.height ? 'landscape' : 'portrait';
          const pdf = new jsPDF({ orientation: firstOrient, unit: 'pt', format: 'a4', compress: true });
          for (let i = 0; i < canvases.length; i++) {
            const c = canvases[i];
            const orient = c.width >= c.height ? 'landscape' : 'portrait';
            if (i > 0) pdf.addPage('a4', orient);
            const pw = pdf.internal.pageSize.getWidth();
            const ph = pdf.internal.pageSize.getHeight();
            const r = Math.min(pw / c.width, ph / c.height);
            const w = c.width * r;
            const h = c.height * r;
            pdf.addImage(c.toDataURL('image/png'), 'PNG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST');
            showProgress(i + 1, canvases.length);
            setStatus('rendering PDF page ' + (i + 1) + '/' + canvases.length + '...');
          }
          pdf.save(baseFilename() + '.pdf');
          setStatus('PDF saved (' + canvases.length + ' page' + (canvases.length === 1 ? '' : 's') + ', mode=' + mode + ')');
        },

        pptx: async () => {
          setStatus('exporting PPTX...');
          await loadScript(URLS.pptxgen);
          await waitForFrame();
          const doc = frame.contentDocument;
          const win = frame.contentWindow;
          if (!doc || !doc.documentElement) {
            throw new Error('iframe document is unavailable (sandbox may be too strict)');
          }
          const PptxGenJS = window.PptxGenJS;
          const pptx = new PptxGenJS();
          pptx.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 inches (16:9)

          // 編集可能パスの判定: reveal.jsでなく、複数の<section>がbody直下/.marpit直下/main直下にあるか
          // win が null/undefined のケース（iframe が同期的に破棄された・クロスオリジン遷移等）
          // を防ぐため win 自身の null チェックを加える。
          const hasReveal = win && win.Reveal && typeof win.Reveal.slide === 'function';
          let editableSections = null;
          if (!hasReveal) {
            for (const sel of ['body > section', '.marpit > section', 'main > section']) {
              const found = Array.from(doc.querySelectorAll(sel));
              if (found.length >= 2) { editableSections = found; break; }
            }
          }

          if (editableSections) {
            // Marpit構造 → ネイティブ要素ベースの編集可能PPTX
            setStatus('building editable PPTX (' + editableSections.length + ' slides)...');
            await buildEditablePptx(pptx, editableSections, doc, win);
            const ttl = extractTitle(getCurrentHtml());
            if (ttl) pptx.title = ttl;
            await pptx.writeFile({ fileName: baseFilename() + '.pptx' });
            setStatus('PPTX saved (' + editableSections.length + ' slides, mode=editable)');
            return;
          }

          // フォールバック: 画像貼り付け（reveal.js / hr区切り / 自由構造）
          const { canvases, mode } = await captureSlides();
          const slideW = 13.333, slideH = 7.5;
          const slideRatio = slideW / slideH;
          for (const canvas of canvases) {
            const imgRatio = canvas.width / canvas.height;
            let w, h;
            if (imgRatio > slideRatio) { w = slideW; h = slideW / imgRatio; }
            else { h = slideH; w = slideH * imgRatio; }
            const s = pptx.addSlide();
            s.addImage({
              data: canvas.toDataURL('image/png'),
              x: (slideW - w) / 2,
              y: (slideH - h) / 2,
              w, h
            });
          }
          const ttl = extractTitle(getCurrentHtml());
          if (ttl) pptx.title = ttl;
          await pptx.writeFile({ fileName: baseFilename() + '.pptx' });
          setStatus('PPTX saved (' + canvases.length + ' slide' + (canvases.length === 1 ? '' : 's') + ', mode=image-' + mode + ')');
        }
      };

      return { captureSlides, exporters };
    }
  };
})();