// uat-codec.js
// HTML 前処理 (A-1 ミニファイ, A-3 静的辞書) と圧縮/展開 (CompressionStream / brotli-wasm /
// LZMA / V6 動的辞書 / V7 SDHT)。index.html から切り出した純ロジックモジュールで、
// DOM や UI への参照を一切持たない。
//
// 依存:
//   window.UAT_DICTS         (dicts.js)         — V1-V5 静的辞書
//   window.UAT_DYNAMIC_DICT  (dynamic-dict.js)  — V6 動的辞書
//   window.UAT_SDHT          (sdht.js)          — V7 SDHT
//
// 公開: window.UAT_CODEC = {
//   minifyHtml, compressHtml, decompressHtml,
//   dictApply, dictReverse, dictCanApply,
//   SHORT_URL_HASH_RE, FORMAT_BY_PREFIX,
//   compressionSupported, decompressSupport,
//   bytesToBase64Url, base64UrlToBytes,
//   withTimeout, loadScript, URLS, loadBrotliWasm,
//   extractTitle, decodeHtmlEntities, sanitizeFilename, formatBytes
// }
(() => {

  // ============================================================
  // 汎用ユーティリティ
  // ============================================================

  // 主要 HTML エンティティを文字に戻す。タイトル抽出やファイル名生成で使い、
  // `<title>Foo &amp; Bar</title>` を `Foo & Bar` として表示する（これをしないと
  // ブラウザタブ、ファイル名、PPTX タイトルに `&amp;` `&#x3042;` といった
  // 実体参照がそのまま残る）。`&amp;` は二重デコード防止のため最後に処理する。
  const decodeHtmlEntities = (s) => String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const cp = parseInt(n, 10);
      // cp > 0x10FFFF など無効なコードポイントで fromCodePoint が RangeError を投げるのを防ぎ、
      // 元の文字参照をそのまま残す。
      try { return Number.isFinite(cp) ? String.fromCodePoint(cp) : _; }
      catch (e) { return _; }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      const cp = parseInt(n, 16);
      try { return Number.isFinite(cp) ? String.fromCodePoint(cp) : _; }
      catch (e) { return _; }
    })
    .replace(/&amp;/g, '&');

  const extractTitle = (html) => {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? decodeHtmlEntities(m[1].trim()) : null;
  };

  const sanitizeFilename = (name) =>
    String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 200) || 'artifact';

  const formatBytes = (n) => {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  };

  /** Promise にタイムアウトを付与。ms 以内に resolve/reject しなければ Error で reject する。
   *  元 Promise が先に settle した場合はタイマーを即座にクリアし、
   *  不要な reject による unhandledrejection イベントの発生を防ぐ。 */
  const withTimeout = (promise, ms, label) => {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error((label || 'operation') + ' timed out (' + (ms / 1000) + 's)')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  // ============================================================
  // 圧縮形式判定 (CompressionStream API サポート)
  // ============================================================

  // CompressionStream API はモダンブラウザでサポート（Compression Streams API: Chrome 80+ / Edge 80+ / Firefox 113+ / Safari 16.4+）
  const compressionSupported = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

  /**
   * 短縮URL用に試行する圧縮形式の定義。試行順 = 同点時の優先順。
   *   zstd       : Firefox 149+ のみ CompressionStream API 対応。HTML系で brotli と同等以上に縮むことがある
   *   brotli     : Chrome 144+ / Edge 144+ / Firefox 147+ / Safari 19+。HTML/CSS/JS で gzip より 15〜25% 短くなる
   *   deflate-raw: 全主要ブラウザで対応。gzip と同じDEFLATE圧縮だがヘッダなしで約 18 バイト短い
   *   gzip       : 全主要ブラウザで対応。互換性のため残す（実質 deflate-raw に劣後）
   *   lzma       : LZMA-JS (CDN遅延ロード)。HTML/CSS/JS で brotli より 5〜15% 縮むことがあるが、圧縮時間は数秒オーダー
   * CompressionStream 系は圧縮側と展開側で個別判定。LZMA は外部ライブラリなので別管理。
   */
  const SHORT_URL_FORMATS_NATIVE = [
    { prefix: 's', format: 'zstd' },
    { prefix: 'b', format: 'brotli' },
    { prefix: 'd', format: 'deflate-raw' },
    { prefix: 'z', format: 'gzip' }
  ];
  const detectFormat = (Ctor, format) => {
    if (!compressionSupported) return false;
    try { new Ctor(format); return true; } catch (e) { return false; }
  };
  const compressSupport = {};
  const decompressSupport = {};
  SHORT_URL_FORMATS_NATIVE.forEach(({ format }) => {
    compressSupport[format] = detectFormat(CompressionStream, format);
    decompressSupport[format] = detectFormat(DecompressionStream, format);
  });
  // 全候補（CompressionStream 系 + LZMA）。LZMA は実行時に CDN ロード後に使用可能。
  const SHORT_URL_FORMATS_ALL = SHORT_URL_FORMATS_NATIVE.concat([{ prefix: 'l', format: 'lzma' }]);
  // プレフィックス → format マップ。小文字 = 辞書なし(v1)、大文字 = 辞書あり(v2, A-3 適用)。
  // 既存の v1 (`#b=...` 等) と互換性を保ちつつ、新規生成は最短採用方式で v1/v2 のどちらかになる。
  const FORMAT_BY_PREFIX = {};
  SHORT_URL_FORMATS_ALL.forEach(({ prefix, format }) => {
    FORMAT_BY_PREFIX[prefix] = format;                  // v1: 辞書なし
    FORMAT_BY_PREFIX[prefix.toUpperCase()] = format;    // v2: 辞書あり
  });
  /**
   * 短縮URLのハッシュ部分を拾う正規表現。
   * プレフィックス形式: [<digit>]<letter>  digit=カスタム辞書バージョン(省略=なし), letter=圧縮形式
   *   小文字 (b/z/d/s/l) = A-3 辞書なし、大文字 (B/Z/D/S/L) = A-3 辞書あり
   *   数字プレフィックス (1b, 1B 等) = カスタム辞書プレフィックス v1〜 適用
   */
  // version プレフィックスは複数桁許容 (\d*)。CURRENT_DICT_VERSION が 10 を超えても動くよう、
  // 将来の辞書追加に備えて多桁対応にしておく。なお customDictVersion=0 (辞書なし) は数字なし表記。
  const SHORT_URL_HASH_RE = /^(\d*)([bzdslBZDSL])=([A-Za-z0-9_-]+)$/;

  // ============================================================
  // HTML 前処理: A-1 ミニファイ + A-3 静的辞書置換
  //   いずれも圧縮前のオプション処理。A-1 は表示上等価なので decoder 不要、
  //   A-3 はプレフィックスが大文字の場合のみ逆処理を実行する。
  // ============================================================

  /**
   * A-1: HTML ミニファイ。表示結果を変えない範囲で空白とコメントを削減する。
   *   - HTML コメントを除去（条件付きコメント `<!--[if IE]>` は保持）
   *   - 連続空白を 1 個のスペースに圧縮 / タグ境界の空白を除去
   *   - <pre> / <textarea> / <script> / <style> / <code> の内部はユニークマーカーで退避して完全保護
   */
  const minifyHtml = (html) => {
    const preserved = [];
    const marker = 'UATPRES' + Math.random().toString(36).slice(2, 10) + 'X';
    const preserve = (m) => { const t = marker + preserved.length + 'X'; preserved.push(m); return t; };
    let work = html;
    // pre/textarea/code はそのまま保護
    work = work.replace(/<(pre|textarea|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, preserve);
    // <script> を <style> より先に保護する。これにより JS 文字列中に含まれる
    // `<style>...</style>` が CSS ミニファイ対象にならず、JS コードが壊れない。
    work = work.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, preserve);
    // <style> 内 CSS をミニファイしてから保護
    work = work.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, o, css, c) => {
      // CSS 中の引用符付き文字列 ("..." / '...') を退避してから minify ルールを適用する。
      // これをしないと content:"Hello, world" のような疑似要素テキスト、font-family:"Foo 0.5"
      // のような特殊フォント名、attr() のフォールバック文字列等の中身が、コンマ畳み込み・
      // 0px→0・0.5→.5・hex短縮・rgba 正規化等によって書き換えられて表示が崩れる。
      // バックスラッシュエスケープ (\" \') を含む文字列にも対応。
      const cssStrings = [];
      const cssMarker = 'UATCSS' + Math.random().toString(36).slice(2, 10) + 'X';
      let s = css.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => {
        const t = cssMarker + cssStrings.length + 'X';
        cssStrings.push(m);
        return t;
      });
      s = s.replace(/\/\*[\s\S]*?\*\//g, '');
      s = s.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      s = s.replace(/\s*\{\s*/g, '{').replace(/;\s*}\s*/g, '}').replace(/\s*}\s*/g, '}');
      // プロパティ宣言のコロン後スペース除去 (font-weight: bold → font-weight:bold)
      // これがないと後続の font-weight:bold→700 や 0px→0 等の短縮が空白付きCSSにマッチしない
      s = s.replace(/:\s+/g, ':');
      // セミコロン前の空白除去 (color: red ; → color:red;)
      s = s.replace(/\s+;/g, ';');
      // #rrggbb → #rgb shorthand (e.g. #ffffff → #fff)
      s = s.replace(/#([0-9a-fA-F])\1([0-9a-fA-F])\2([0-9a-fA-F])\3\b/g, '#$1$2$3');
      // 0px/0em/etc → 0 (unitless zero is valid for CSS lengths)
      s = s.replace(/\b0+(\.0+)?(px|em|rem|vh|vw|vmin|vmax|ch|ex)\b/g, '0');
      // 0.5 → .5 (leading zero removal)
      // 直前が数字・ドット以外のときだけ leading 0 を除去する。単純な \b による境界判定では
      // `url(image-1.0.5.png)` のように小数点が連続するパターンで `1..5` に化けてしまうため、
      // (^|[^0-9.]) で前文脈を厳密にチェックして「数字 → 0 → ドット → 数字」の連鎖を保護する。
      s = s.replace(/(^|[^0-9.])0\.(\d)/g, '$1.$2');
      // font-weight shorthand (bold→700, normal→400)
      s = s.replace(/font-weight:bold\b/g, 'font-weight:700');
      s = s.replace(/font-weight:normal\b/g, 'font-weight:400');
      // rgb/rgba の固定パターンを短縮形へ変換。色値の冗長表記を1パターンに集約し辞書・LZマッチ効率を上げる。
      // alpha=1 は #rrggbb 同等、alpha=0 は transparent 同等として安全。
      s = s.replace(/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*1\s*\)/g, '#000');
      s = s.replace(/rgba?\(\s*255\s*,\s*255\s*,\s*255\s*,\s*1\s*\)/g, '#fff');
      s = s.replace(/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/g, 'transparent');
      s = s.replace(/rgba?\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0\s*\)/g, 'transparent');
      // margin/padding の同値ショートハンド。CSSは1値=全方向、3値 0 0 0 は上・左右・下として全て 0 なので 1値に集約可能。
      s = s.replace(/\b(margin|padding):0 0 0 0\b/g, '$1:0');
      s = s.replace(/\b(margin|padding):0 0 0\b(?![ \d])/g, '$1:0');
      s = s.replace(/\b(margin|padding):0 0\b(?![ \d])/g, '$1:0');
      // outline:none → outline:0 (1文字短縮)、border:none → border:0 (3文字短縮)
      // background:none は border-image 付きショートハンドとは意味が違うため変換しない (安全側)。
      s = s.replace(/\boutline:none\b/g, 'outline:0');
      s = s.replace(/\bborder:none\b/g, 'border:0');
      s = s.replace(/\bborder-(top|right|bottom|left):none\b/g, 'border-$1:0');
      // 並んだセレクターコンマの前後空白を除去する (a , b → a,b)
      s = s.replace(/\s*,\s*/g, ',');
      // 閉じ括弧の前にある最後のプロパティの ; は不要 (color:red;} → color:red})
      s = s.replace(/;}/g, '}');
      // 退避した文字列を復元
      const cssRestoreRe = new RegExp(cssMarker + '(\\d+)X', 'g');
      s = s.replace(cssRestoreRe, (_, idx) => cssStrings[parseInt(idx, 10)] || '');
      return preserve(o + s + c);
    });
    // HTML コメント除去（条件付きコメントは保持）
    work = work.replace(/<!--([\s\S]*?)-->/g, (m, body) => /^\[if\b/i.test(body) ? m : '');
    // 連続空白圧縮 / タグ境界の空白除去
    work = work.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
    // 冗長な type 属性を除去
    work = work.replace(/ type=["']text\/javascript["']/gi, '');
    work = work.replace(/ type=["']text\/css["']/gi, '');
    // Boolean 属性を短縮 (checked="checked" → checked)。
    // クォートあり版で値ごと落としたあと、未クォート版 (checked=checked / disabled=true 等) も
    // 同じく属性名だけに削る。HTML5 仕様では Boolean 属性は値の有無に関わらず「存在 = true」なので、
    // 値の中身は安全に捨てて良い。属性ソート前の段階でこれをやっておくことで、`disabled=disabled` と
    // `disabled` が同一トークン化され、辞書 / LZ マッチがより効きやすくなる副次効果もある。
    work = work.replace(/ (checked|disabled|readonly|required|autofocus|autoplay|controls|defer|async|hidden|multiple|selected|novalidate)=["'][^"']*["']/gi, ' $1');
    work = work.replace(/ (checked|disabled|readonly|required|autofocus|autoplay|controls|defer|async|hidden|multiple|selected|novalidate)=[^\s"'`=<>\/]+/gi, ' $1');
    // オプショナル閉じタグを除去（HTML仕様で省略可能、ブラウザは正しくパースする）
    // </p> はブロック要素が続く場合のみ安全に省略可能（インライン要素が続くと DOM 構造が変わる）
    work = work.replace(/<\/p>(?=<(?:p|div|h[1-6]|ul|ol|dl|table|blockquote|pre|hr|section|article|aside|nav|header|footer|main|form|fieldset|figure|figcaption|details|address|menu|hgroup)\b)/gi, '');
    // </li>, </td>, </th>, </tr> 等は後続の兄弟タグや親閉じタグで自動クローズされる
    work = work.replace(/<\/(?:li|td|th|tr|dt|dd|option|colgroup|thead|tbody|tfoot)>/gi, '');
    // 構造タグの閉じタグを除去（</html>, </head>, </body> は常に省略可能）
    work = work.replace(/<\/(?:html|head|body)>/gi, '');
    // 属性値の引用符を省略（値が英数字・ハイフン・ドット・アンダースコアのみの場合）
    work = work.replace(/=["']([a-zA-Z0-9_\-\.]+)["']/g, '=$1');
    // デフォルト type 属性を除去（button の submit と input の text はデフォルト値）
    work = work.replace(/(<button\b[^>]*?) type=submit/gi, '$1');
    work = work.replace(/(<input\b[^>]*?) type=text/gi, '$1');
    // HTML エンティティを短い形式に正規化。&apos; は HTML5 で初出だが &#39; は HTML4 も含め全ブラウザでサポートされており 1 文字短い。
    // <pre>/<script>/<style>/<textarea>/<code> 内は preserve 済みなので、コード中の &apos; リテラルを誤って変換する事故は起きない。
    work = work.replace(/&apos;/g, '&#39;');
    // 属性のアルファベット順ソート（LZ系圧縮の繰り返しパターン増加目的）。
    // pre/textarea/script/style/code は preserve 済みなので attrsStr にマーカー文字列が含まれることはない。
    // case-insensitive ソートにより SVG の viewBox / preserveAspectRatio など大文字混じり属性も
    // 周りの小文字属性と一貫した順序で並ぶ。重複属性（例: class=a class=b）はそのまま保持
    // （実際には不正な HTML だが、ブラウザは先頭の値を採用するためソートしても意味を保つ）。
    // outer regex は「タグ名 + 1個以上の属性 + (optional /) + >」を明示的にマッチさせる。
    // 単に [^<>]*? にすると <a title="2 > 1"> のように引用符内の > でタグが切られて
    // 属性値を損ねる事故が起きるため、引用あり値をクォート規則ではなくトークンレベルで認識させる。
    work = work.replace(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:=(?:"[^"]*"|'[^']*'|[^\s"'`=<>]+))?)+)\s*(\/?)>/g, (match, tag, attrsStr, slash) => {
      // 属性なし or 単一属性は変換不要。クォート/未クォート/値なしをすべてキャッチ。
      const re = /([a-zA-Z_:][\w:.-]*)(?:=("[^"]*"|'[^']*'|[^\s"'`=<>\/]+))?/g;
      const list = [];
      let am;
      while ((am = re.exec(attrsStr))) {
        list.push({ name: am[1], value: am[2] });
      }
      if (list.length < 2) return match;
      // 安定ソート（name が同じ場合は元順）にするため index を tiebreaker に使う。
      const indexed = list.map((a, i) => ({ a, i }));
      indexed.sort((x, y) => {
        const xn = x.a.name.toLowerCase(), yn = y.a.name.toLowerCase();
        if (xn < yn) return -1;
        if (xn > yn) return 1;
        return x.i - y.i;
      });
      return '<' + tag + indexed.map(({ a }) => ' ' + a.name + (a.value !== undefined ? '=' + a.value : '')).join('') + slash + '>';
    });
    // マーカー復元
    const restoreRe = new RegExp(marker + '(\\d+)X', 'g');
    work = work.replace(restoreRe, (_, idx) => preserved[parseInt(idx, 10)] || '');
    return work;
  };

  /**
   * A-3: 静的辞書置換。HTML で頻出する長いトークン（`<!DOCTYPE html>` 等）を、
   * NUL/TAB/LF/CR を避けた 0x01-0x1F の制御文字 1 バイトに置換する。decoder は同じテーブルで逆処理する。
   * 元 HTML がいずれかのセンチネル文字を既に含んでいる場合は適用不可（dictCanApply で判定）。
   * トークンは互いに部分一致しないように選定（split/join はメタ文字を気にせず確実に置換できる）。
   */
  const DICT_TOKENS = [
    // 属性は minifyHtml の最終ステップでアルファベット順にソートされるため、
    // 辞書側も c < n の順 (content → name) で登録する必要がある。逆順にすると
    // 入力 HTML 側に永久に一致せず A-3 静的辞書による圧縮が効かない。
    '<meta content="width=device-width,initial-scale=1.0" name=viewport>',
    '<meta content="width=device-width,initial-scale=1" name=viewport>',
    '<meta charset=UTF-8>',
    '<meta charset=utf-8>',
    '<!DOCTYPE html>',
    '<!doctype html>',
    '<html lang=ja>',
    '<html lang=en>',
    'justify-content:',
    'background-color:',
    'border-radius:',
    '<div class="',
    'align-items:',
    'font-weight:',
    'text-align:',
    'font-size:',
    '</section>',
    '<\/script>',
    '</button>',
    '<section ',
    '<section>',
    '</header>',
    '<header>',
    '<script>',
    '</style>',
    '<style>',
    '</span>',
    '</div>'
  ];
  const DICT_SENTINELS = (() => {
    const arr = [];
    for (let cc = 0x01; cc <= 0x1F && arr.length < DICT_TOKENS.length; cc++) {
      if (cc === 0x09 || cc === 0x0A || cc === 0x0D) continue;
      arr.push(String.fromCharCode(cc));
    }
    return arr;
  })();
  const DICT_PAIRS = DICT_TOKENS.slice(0, DICT_SENTINELS.length).map((tok, i) => [tok, DICT_SENTINELS[i]]);
  const dictCanApply = (html) => {
    for (const [, s] of DICT_PAIRS) if (html.indexOf(s) >= 0) return false;
    return true;
  };
  const dictApply = (html) => {
    let out = html;
    for (const [tok, sen] of DICT_PAIRS) out = out.split(tok).join(sen);
    return out;
  };
  const dictReverse = (html) => {
    let out = html;
    for (const [tok, sen] of DICT_PAIRS) out = out.split(sen).join(tok);
    return out;
  };

  // ============================================================
  // 圧縮 / 展開（Copy Short URL 用）
  //   方針: HTML を A-1 ミニファイ → A-3 辞書ありなし両方トライ → 全形式 (zstd/brotli/deflate-raw/gzip/LZMA)
  //         で並列圧縮 → 最短採用。プレフィックス小文字 = 辞書なし v1、大文字 = 辞書あり v2。
  // ============================================================

  /** Uint8Array → base64url（URL安全） */
  const bytesToBase64Url = (bytes) => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  /** base64url → Uint8Array */
  const base64UrlToBytes = (b64url) => {
    let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad) b64 += '='.repeat(4 - pad);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  // ============================================================
  // brotli-wasm (quality 11, CDN 遅延ロード)
  //   CompressionStream('brotli') はデフォルト quality 4〜6 程度。brotli-wasm を
  //   quality 11（最大）で使うと 10〜25% 追加圧縮が見込める。出力は標準 Brotli
  //   ストリームのため DecompressionStream('brotli') で展開可能。非対応ブラウザ
  //   では brotli-wasm 自体で展開にフォールバックする。
  // ============================================================
  // loadScript と同様に Promise をキャッシュし、並行呼び出し時の二重ロードを防止する。
  // 失敗時はキャッシュを破棄してリトライ可能にする。
  let _brotliWasmP = null;
  const loadBrotliWasm = () => {
    if (_brotliWasmP) return _brotliWasmP;
    // loadScript と同様に 30 秒でタイムアウト。CDN がハングすると import() が永久に
    // 解決されず、compressHtml の Promise.all や brotli フォールバック展開が固まるため。
    _brotliWasmP = withTimeout((async () => {
      const mod = await import('https://unpkg.com/brotli-wasm@3.0.0/index.web.js');
      let brotli = mod.default || mod;
      if (typeof brotli === 'function') brotli = await brotli();
      if (brotli && typeof brotli.then === 'function') brotli = await brotli;
      if (!brotli || typeof brotli.compress !== 'function') throw new Error('brotli-wasm: invalid module');
      return brotli;
    })(), 30000, 'brotli-wasm load').catch(e => { _brotliWasmP = null; throw e; });
    return _brotliWasmP;
  };
  const compressBrotliWasm = async (text) => {
    const brotli = await loadBrotliWasm();
    const compressed = brotli.compress(new TextEncoder().encode(text), { quality: 11 });
    return bytesToBase64Url(new Uint8Array(compressed));
  };
  const decompressBrotliWasm = async (b64url) => {
    const brotli = await loadBrotliWasm();
    const decompressed = brotli.decompress(base64UrlToBytes(b64url));
    return new TextDecoder().decode(decompressed);
  };

  // ============================================================
  // カスタム辞書圧縮 (バージョン管理・拡張可能設計)
  //   圧縮前に HTML/CSS/JS/日本語頻出パターンの辞書文字列をデータ先頭に付加する。
  //   LZ系圧縮のスライディングウィンドウ内に辞書パターンが配置されるため、
  //   実データ中のマッチが後方参照で効率よく符号化され、圧縮率が改善される。
  //   辞書本体 (V1, V2, V3, V4 …) は dicts.js に切り出されており、
  //   window.UAT_DICTS = { CUSTOM_DICTS, CURRENT_DICT_VERSION } で公開される。
  //   新バージョン追加は dicts.js の編集のみで完結し、index.html への変更は不要。
  //   旧バージョンの辞書は削除しないため、過去の URL は常にデコード可能。
  //   dicts.js のロード失敗時 (ネットワークエラー、blocker 等) は無辞書モードで
  //   動作させる。圧縮率は下がるが、A-1 ミニファイと A-3 静的辞書の組み合わせは
  //   引き続き機能するため、Copy Short URL 自体は常に動作する。
  // ============================================================
  const _UAT_DICTS = window.UAT_DICTS;
  if (!_UAT_DICTS || !Array.isArray(_UAT_DICTS.CUSTOM_DICTS)) {
    console.error('[url-to-artifact] dicts.js failed to load; custom dictionary compression disabled');
  }
  const CUSTOM_DICTS = (_UAT_DICTS && _UAT_DICTS.CUSTOM_DICTS) || [null];
  const CURRENT_DICT_VERSION = (_UAT_DICTS && typeof _UAT_DICTS.CURRENT_DICT_VERSION === 'number') ? _UAT_DICTS.CURRENT_DICT_VERSION : 0;

  // ============================================================
  // V6 動的辞書 (dynamic-dict.js)
  //   コンテンツ依存辞書: 圧縮直前に HTML 本体から頻出 n-gram を抽出し、
  //   V5 静的辞書 + 動的辞書 + 本体 の 3 段プレフィックスで圧縮する。
  //   URL ペイロード先頭に varint で動的辞書長を埋め込み、デコーダはそれを
  //   読み出して slice する。dynamic-dict.js のロードに失敗した場合は V6
  //   バリアントを生成せず、V5 までで動作を継続する (URL 互換性に影響なし)。
  // ============================================================
  const _UAT_DYN = window.UAT_DYNAMIC_DICT;
  if (!_UAT_DYN || typeof _UAT_DYN.buildDictionary !== 'function') {
    console.warn('[url-to-artifact] dynamic-dict.js not loaded; V6 dynamic dictionary disabled');
  }
  const DYNAMIC_DICT_AVAILABLE = !!(_UAT_DYN
    && typeof _UAT_DYN.buildDictionary === 'function'
    && typeof _UAT_DYN.chooseBudget === 'function'
    && typeof _UAT_DYN.varintEncode === 'function'
    && typeof _UAT_DYN.varintDecode === 'function');
  // V6 は常に V5 静的辞書 + 動的辞書の組み合わせ。将来 V7 静的辞書が追加された際は
  // 別の cdv 値 (7 等) を割り当て、本定数を分岐させる。
  const STATIC_DICT_FOR_V6 = 5;

  // ============================================================
  // V7 SDHT (sdht.js)
  //   コンテンツ依存トークン置換: 圧縮直前に HTML 本体から頻出 n-gram を抽出し、
  //   ESC + index の 2 バイトトークンに置換した後で圧縮する。V6 が LZ 圧縮の
  //   辞書プレフィックスとして外部辞書を提供するのに対し、V7 は本体を物理的に
  //   短縮してから圧縮器に渡す。両者は補完関係。
  //   sdht.js のロード失敗時は V7 バリアントを生成せず、V1〜V6 で動作を継続する。
  // ============================================================
  const _UAT_SDHT = window.UAT_SDHT;
  if (!_UAT_SDHT || typeof _UAT_SDHT.encode !== 'function') {
    console.warn('[url-to-artifact] sdht.js not loaded; V7 in-body tokenization disabled');
  }
  const SDHT_AVAILABLE = !!(_UAT_SDHT
    && typeof _UAT_SDHT.encode === 'function'
    && typeof _UAT_SDHT.decode === 'function');

  /** 辞書をデータ先頭に付加 */
  const dictPrefixApply = (text, version) => {
    const dict = CUSTOM_DICTS[version];
    return dict ? dict + text : text;
  };
  /** 辞書プレフィックスを除去（辞書の固定長分を先頭からスキップ） */
  const dictPrefixStrip = (text, version) => {
    const dict = CUSTOM_DICTS[version];
    return dict ? text.slice(dict.length) : text;
  };

  /** UTF-8 エンコード → CompressionStream(format) → base64url。format は brotli/gzip/deflate-raw/zstd */
  const compressWithStream = async (text, format) => {
    const enc = new TextEncoder();
    const stream = new Blob([enc.encode(text)]).stream().pipeThrough(new CompressionStream(format));
    const buf = await new Response(stream).arrayBuffer();
    return bytesToBase64Url(new Uint8Array(buf));
  };
  /** base64url → DecompressionStream(format) → UTF-8 文字列 */
  const decompressWithStream = async (b64url, format) => {
    const bytes = base64UrlToBytes(b64url);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    const buf = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(buf);
  };

  /** LZMA-JS をラップした圧縮（callback → Promise）。mode 9 = 最大圧縮。 */
  const compressLzma = async (text) => {
    await loadScript(URLS.lzma);
    if (!window.LZMA) throw new Error('LZMA library failed to load');
    // LZMA mode 9 は大きな入力で数十秒かかることがある。Web Worker がストールまたは
    // クラッシュすると callback が永久に呼ばれず Promise がハングし、UI が busy のまま
    // 固まる事故を防ぐため、30 秒でタイムアウトさせる。
    const out = await withTimeout(new Promise((resolve, reject) => {
      window.LZMA.compress(text, 9, (result, err) => {
        if (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
        // ワーカー異常や中断ケースで result が null/undefined になると、以前のコードでは
        // result.length で TypeError が出て原因不明のエラーになっていたため、明示メッセージで reject。
        if (!result || typeof result.length !== 'number') {
          reject(new Error('LZMA compress returned no data'));
          return;
        }
        // result は Int8Array または number[]。Uint8Array に正規化。
        const bytes = new Uint8Array(result.length);
        for (let i = 0; i < result.length; i++) bytes[i] = result[i] & 0xFF;
        resolve(bytes);
      });
    }), 30000, 'LZMA compress');
    return bytesToBase64Url(out);
  };
  /** LZMA-JS の展開。decompress 結果は string（UTF-8 デコード済み）。 */
  const decompressLzma = async (b64url) => {
    await loadScript(URLS.lzma);
    if (!window.LZMA) throw new Error('LZMA library failed to load');
    const bytes = base64UrlToBytes(b64url);
    const arr = Array.from(bytes); // LZMA.decompress は Array<number> または Int8Array を受け取る
    // 展開は通常高速だが、Worker ストール対策として 15 秒でタイムアウト。
    return await withTimeout(new Promise((resolve, reject) => {
      window.LZMA.decompress(arr, (result, err) => {
        if (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
        // result が null/undefined のとき String(result) は "null"/"undefined" という文字列になるため
        // 明示エラーとして reject し、それを HTML として描画してしまう事故を防ぐ。
        if (result === null || result === undefined) {
          reject(new Error('LZMA decompress returned no data'));
          return;
        }
        resolve(typeof result === 'string' ? result : String(result));
      });
    }), 15000, 'LZMA decompress');
  };

  /** format 別の展開ディスパッチャ。戻り値: UTF-8 文字列。 */
  const decompressByFormat = async (b64url, format) => {
    if (format === 'lzma') return decompressLzma(b64url);
    return decompressWithStream(b64url, format);
  };

  /**
   * Copy Short URL の本体。HTML を A-1 ミニファイし、以下の組み合わせを並列に試行して最短ペイロードを採用:
   *   - 前処理: ±A-3 静的辞書 × ±カスタム辞書プレフィックス (v1〜)
   *   - 圧縮: zstd / brotli / brotli-wasm(q11) / deflate-raw / gzip / LZMA
   * プレフィックス形式: [<digit>]<letter>  digit=辞書バージョン, letter=圧縮形式(大文字=A-3)
   * 戻り値: { format, prefix, dict, customDictVersion, payload, preprocessedSize }
   */
  const compressHtml = async (html) => {
    const minified = minifyHtml(html);
    // 前処理バリアント: ±A-3 辞書 × ±カスタム辞書プレフィックス
    const a3ok = dictCanApply(minified);
    const a3text = a3ok ? dictApply(minified) : null;
    const variants = [
      { text: minified, a3: false, cdv: 0 }
    ];
    if (a3ok) variants.push({ text: a3text, a3: true, cdv: 0 });
    // dicts.js のロード失敗時 (CURRENT_DICT_VERSION === 0) や、CUSTOM_DICTS[N] が null
    // (バージョン配列に欠番がある異常時) には、dictPrefixApply は text をそのまま返すため
    // 上の no-dict 変種と完全に同じ入力になる。重複した変種を 6 圧縮器に投げると 12 トライが
    // 純粋に無駄になり、Copy Short URL の所要時間が約 2 倍になる。利用可能な辞書がある
    // ときのみ追加する。
    if (CUSTOM_DICTS[CURRENT_DICT_VERSION]) {
      variants.push({ text: dictPrefixApply(minified, CURRENT_DICT_VERSION), a3: false, cdv: CURRENT_DICT_VERSION });
      if (a3ok) variants.push({ text: dictPrefixApply(a3text, CURRENT_DICT_VERSION), a3: true, cdv: CURRENT_DICT_VERSION });
    }
    // V6 動的辞書バリアント: dynamic-dict.js が利用可能 + V5 静的辞書がロード済 + 本体が
    // chooseBudget の閾値を超える場合のみ生成する。動的辞書は本体の n-gram から構築するため、
    // A-3 適用前後で別途構築する (control-byte 置換後の方が短く整列することがある)。
    if (DYNAMIC_DICT_AVAILABLE && CUSTOM_DICTS[STATIC_DICT_FOR_V6]) {
      const v6Static = CUSTOM_DICTS[STATIC_DICT_FOR_V6];
      const v6Budget = _UAT_DYN.chooseBudget(minified.length);
      if (v6Budget > 0) {
        try {
          const dynNoA3 = _UAT_DYN.buildDictionary(minified, v6Budget);
          if (dynNoA3) {
            variants.push({ text: v6Static + dynNoA3 + minified, a3: false, cdv: 6, dynDictLen: dynNoA3.length });
          }
          if (a3ok) {
            const dynA3 = _UAT_DYN.buildDictionary(a3text, v6Budget);
            if (dynA3) {
              variants.push({ text: v6Static + dynA3 + a3text, a3: true, cdv: 6, dynDictLen: dynA3.length });
            }
          }
        } catch (e) {
          // 動的辞書構築失敗時は V6 をスキップして V5 までを採用 (LOG だけ残す)。
          console.warn('[url-to-artifact] V6 dynamic dictionary build failed:', e && e.message ? e.message : e);
        }
      }
    }
    // V7 SDHT バリアント: 本体内トークン置換。chooseBudget で本体長閾値を判定し、
    // 利得が見込める場合のみ追加する。SDHT.encode は失敗時 null を返すので
    // try/catch は予期しない例外 (バグ) の保険として置いておく。A-3 適用前後で
    // 別途 encode する: A-3 後の本体は制御文字 0x01-0x1C が散らばっており、SDHT が
    // 抽出する n-gram もそれを含むため、A-3 ありなしで最適な辞書が異なる。
    if (SDHT_AVAILABLE) {
      try {
        const sdhtNoA3 = _UAT_SDHT.encode(minified);
        if (sdhtNoA3) {
          variants.push({ text: sdhtNoA3, a3: false, cdv: 7 });
        }
        if (a3ok) {
          const sdhtA3 = _UAT_SDHT.encode(a3text);
          if (sdhtA3) {
            variants.push({ text: sdhtA3, a3: true, cdv: 7 });
          }
        }
      } catch (e) {
        console.warn('[url-to-artifact] V7 SDHT encode failed:', e && e.message ? e.message : e);
      }
    }
    // 圧縮器リスト: CompressionStream 系 + LZMA + brotli-wasm(q11)
    const compressors = [
      ...SHORT_URL_FORMATS_NATIVE.filter(({ format }) => compressSupport[format]).map(f => ({
        pfx: f.prefix, fmt: f.format, fn: (t) => compressWithStream(t, f.format)
      })),
      { pfx: 'l', fmt: 'lzma', fn: (t) => compressLzma(t) },
      { pfx: 'b', fmt: 'brotli', fn: (t) => compressBrotliWasm(t) }
    ];
    if (compressors.length === 0) throw new Error('no compression formats are available');
    // 全組み合わせを並列試行
    const trials = [];
    for (const v of variants) {
      for (const c of compressors) {
        trials.push({ text: v.text, a3: v.a3, cdv: v.cdv, dynDictLen: v.dynDictLen, pfx: c.pfx, fmt: c.fmt, fn: c.fn });
      }
    }
    const results = (await Promise.all(trials.map(async (t) => {
      try {
        let payload = await t.fn(t.text);
        // V6: 圧縮ペイロード先頭に「動的辞書長 (varint)」を埋め込む。base64 を 1 度デコード
        // → varint と結合 → 再 base64 と 2 ラウンドかかるが、V6 トライアルのみなので影響小。
        if (t.cdv === 6 && DYNAMIC_DICT_AVAILABLE) {
          const compressedBytes = base64UrlToBytes(payload);
          const varintBytes = _UAT_DYN.varintEncode(t.dynDictLen);
          const combined = new Uint8Array(varintBytes.length + compressedBytes.length);
          combined.set(varintBytes, 0);
          combined.set(compressedBytes, varintBytes.length);
          payload = bytesToBase64Url(combined);
        }
        const letter = t.a3 ? t.pfx.toUpperCase() : t.pfx;
        const prefix = (t.cdv > 0 ? String(t.cdv) : '') + letter;
        return { format: t.fmt, prefix, dict: t.a3, customDictVersion: t.cdv, payload, preprocessedSize: t.text.length };
      } catch (e) { return null; }
    }))).filter(Boolean);
    if (results.length === 0) throw new Error('compression failed for all available formats');
    // URL 全体長 (#prefix=payload) で比較する。payload のみの比較だと、cdv プレフィックス
    // (例: '7' = 1 文字、'5' = 1 文字) のオーバーヘッドが無視され、同 payload 長でも V0 の方が
    // 短い URL になるケースで V5/V6/V7 を採用してしまい URL が無駄に 1、2 文字長くなる事故を防ぐ。
    return results.reduce((best, cur) =>
      (cur.prefix.length + cur.payload.length) < (best.prefix.length + best.payload.length) ? cur : best
    );
  };

  /**
   * format + base64url + dictApplied + customDictVersion から UTF-8 HTML を復元する。
   * brotli で DecompressionStream 非対応の場合は brotli-wasm にフォールバック。
   * customDictVersion > 0 → 辞書プレフィックス除去、dictApplied=true → A-3 逆処理。
   */
  const decompressHtml = async (format, b64url, dictApplied, customDictVersion) => {
    // V6 (動的辞書 + V5 静的辞書): ペイロード先頭の varint で動的辞書長を読み、
    // 圧縮データを切り出し、展開後に「V5 辞書長 + 動的辞書長」分を slice で除去する。
    // この分岐は customDictVersion > 0 の汎用パスより前に置く必要がある (CUSTOM_DICTS[6]
    // は存在しないため汎用パスに落ちるとエラーになる)。
    if (customDictVersion === 6) {
      if (!DYNAMIC_DICT_AVAILABLE) {
        throw new Error('V6 URL but dynamic-dict.js failed to load');
      }
      const v6Static = CUSTOM_DICTS[STATIC_DICT_FOR_V6];
      if (!v6Static) {
        throw new Error('V6 requires V' + STATIC_DICT_FOR_V6 + ' static dictionary but none loaded');
      }
      const allBytes = base64UrlToBytes(b64url);
      const decoded = _UAT_DYN.varintDecode(allBytes, 0);
      const dynDictLen = decoded.value;
      const compressedBytes = allBytes.slice(decoded.nextOffset);
      const compressedB64 = bytesToBase64Url(compressedBytes);
      let raw;
      if (format === 'brotli' && !decompressSupport['brotli']) {
        raw = await decompressBrotliWasm(compressedB64);
      } else {
        raw = await decompressByFormat(compressedB64, format);
      }
      const headerLen = v6Static.length + dynDictLen;
      if (raw.length < headerLen) {
        throw new Error('V6 decompressed text too short for headers (got ' + raw.length + ', need ' + headerLen + ')');
      }
      const stripped = raw.slice(headerLen);
      return dictApplied ? dictReverse(stripped) : stripped;
    }
    // V7 SDHT (本体内トークン置換): 圧縮ペイロード = compress(SDHT.encode(body)) なので、
    // 展開後にそのまま SDHT.decode を通せば元の (ミニファイ済み) 本体に戻る。
    // varint 解析は SDHT.decode 内で行うため、index.html 側で base64 を 2 度 round-trip する必要がない。
    if (customDictVersion === 7) {
      if (!SDHT_AVAILABLE) {
        throw new Error('V7 URL but sdht.js failed to load');
      }
      let raw;
      if (format === 'brotli' && !decompressSupport['brotli']) {
        raw = await decompressBrotliWasm(b64url);
      } else {
        raw = await decompressByFormat(b64url, format);
      }
      const decoded = _UAT_SDHT.decode(raw);
      return dictApplied ? dictReverse(decoded) : decoded;
    }
    let text;
    if (format === 'brotli' && !decompressSupport['brotli']) {
      text = await decompressBrotliWasm(b64url);
    } else {
      text = await decompressByFormat(b64url, format);
    }
    if (customDictVersion > 0) {
      if (!CUSTOM_DICTS[customDictVersion]) throw new Error('unsupported custom dictionary version: ' + customDictVersion);
      text = dictPrefixStrip(text, customDictVersion);
    }
    return dictApplied ? dictReverse(text) : text;
  };

  // ============================================================
  // Lazy library loader
  // ============================================================
  // タイムアウトを設定して、CDN がハングした場合に await loadScript() が永遠に
  // 解決されず、エクスポートボタンが busy のまま固まる事故を防ぐ。
  // 30 秒でも load も error も発火しない場合は明示エラーで reject、
  // _loaded の cache を delete してリトライ可能な状態に戻す。
  const _loaded = {};
  const SCRIPT_LOAD_TIMEOUT_MS = 30000;
  const loadScript = (url) => _loaded[url] || (_loaded[url] = new Promise((res, rej) => {
    const s = document.createElement('script');
    let done = false;
    let timer = 0;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (ok) {
        res();
      } else {
        // 失敗 (onerror / タイムアウト) 時は <script> 要素を DOM から取り除く。
        // 一部ブラウザは同一 src の <script> が DOM 上に残っていると、再 append しても
        // 「キャッシュ済み」と判断して onload を再発火しない実装差があり、リトライ呼び出しが
        // 永遠に hang してエクスポートボタンが busy のまま固まる事故が起きる。
        // 要素を切り離しておくことで、次回 loadScript はクリーンな新しい <script> を挿入でき、
        // 確実に load / error / タイムアウトのいずれかへ収束する。
        try { if (s.parentNode) s.parentNode.removeChild(s); } catch (e) { /* ignore */ }
        delete _loaded[url];
        rej(err);
      }
    };
    s.src = url;
    s.async = true;
    s.onload = () => finish(true);
    s.onerror = () => finish(false, new Error('Failed to load library: ' + url));
    timer = setTimeout(
      () => finish(false, new Error('Library load timed out (' + (SCRIPT_LOAD_TIMEOUT_MS / 1000) + 's): ' + url)),
      SCRIPT_LOAD_TIMEOUT_MS
    );
    document.head.appendChild(s);
  }));
  const URLS = {
    html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    jspdf:       'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    pptxgen:     'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
    jszip:       'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    // LZMA-JS 2.3.2 (pure-JS LZMA1 圧縮/展開)。Copy Short URL でブラウザ内蔵 CompressionStream
    // (zstd / Brotli / deflate-raw / gzip) と並列に試行し最短ペイロードを採用する。worker版は
    // window.LZMA グローバルに Web Worker を内部生成 (Blob URL)。約85KB minified、外部送信ゼロ。
    lzma:        'https://cdn.jsdelivr.net/npm/lzma@2.3.2/src/lzma_worker-min.js'
  };

  // ============================================================
  // 公開: window.UAT_CODEC
  //   sibling モジュール (UAT_DICTS / UAT_DYNAMIC_DICT / UAT_SDHT) と作法を揃え、
  //   ロード後の改ざん (拡張機能・別スクリプト等による外部書き換え) を防ぐために
  //   Object.freeze する。関数本体は元々 immutable なので個別凍結は不要。
  //   FORMAT_BY_PREFIX / decompressSupport は内部 detail のオブジェクトで参照のみされるため
  //   一段だけ凍結すれば十分。
  // ============================================================
  window.UAT_CODEC = Object.freeze({
    // 前処理
    minifyHtml,
    dictApply, dictReverse, dictCanApply,
    // 圧縮 / 展開
    compressHtml, decompressHtml,
    // 短縮 URL 解析 (render() / uatProcessPaste から使用)
    SHORT_URL_HASH_RE, FORMAT_BY_PREFIX,
    compressionSupported, decompressSupport,
    // base64url 変換
    bytesToBase64Url, base64UrlToBytes,
    // 共通ユーティリティ
    withTimeout,
    // ライブラリローダ (uat-export.js も使用)
    loadScript, URLS,
    loadBrotliWasm,
    // テキスト処理
    extractTitle, decodeHtmlEntities, sanitizeFilename, formatBytes
  });
})();