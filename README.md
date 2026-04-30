# Artifact Viewer

URLのハッシュに埋め込んだHTMLをレンダリングし、HTML / PNG / PDF / PPTX として保存できるシンプルなビューアです。

**公開URL**: <https://anomori.github.io/url-to-artifact/>

**動作デモ**: [Hello World](https://anomori.github.io/url-to-artifact/#%3Ch1%3EHello%3C/h1%3E%3Cp%3E%E6%9C%AC%E6%96%87%3C/p%3E)

## 何ができるか

- URL の `#` 以降にHTMLを書くと、その場でレンダリングします
- ツールバーから現在のアーティファクトを以下の形式で保存できます
    - HTML — ソースをそのまま .html としてダウンロードします
    - PNG  — スライド検出時は各スライドを ZIP アーカイブ、それ以外は全体1枚の PNG になります
    - PDF  — スライド検出時は1スライド=1ページ、単一アーティファクトは縦横比からA4の向きを自動選択し長辺方向にページ分割します（縦長い記事も横長いダッシュボードも対応、jsPDF）
    - PPTX — Marpit形式の `<section>` ベースのスライドは**編集可能なネイティブPPTX**として出力します（見出し・段落・箇条書き・表・画像が個別のPowerPoint要素として配置され、文字編集・検索・読み上げが可能です）。reveal.js / `<hr>` 区切り / 自由構造の場合は画像貼り付けのフォールバックになります（pptxgenjs）
- Copy URL ボタンで現在URLをクリップボードにコピーできます。圧縮URL（`#b=...` / `#z=...`）で開いている場合は、展開後の生HTMLを `#` 以降にそのまま埋めた「非圧縮の元URL」を生成してコピーします（AIに読ませたり、デコードして中身を見たい場合に便利です）
- Copy Short URL ボタンで、現在のアーティファクトを圧縮した短縮URLとしてクリップボードにコピーできます。圧縮前に **A-1 ミニファイ**（HTML から不要な空白・コメント削除、CSS圧縮、冗長な属性除去、表示は等価）を適用し、さらに **A-3 静的辞書置換**（HTML頻出トークン28種を1バイトの制御文字に置換）、**カスタム静的辞書プレフィックス**（HTML/CSS/JS/日本語頻出パターン約 8.5 KB を `dicts.js` から読み込んでデータ先頭に付加し、LZ系圧縮の後方参照効率を向上）、および **V6 動的辞書**（`dynamic-dict.js` が本体HTMLから頻出 n-gram を抽出して 128〜1024B のコンテンツ依存辞書をランタイム構築し、V5 静的辞書と併用）、さらに **V7 SDHT**（`sdht.js` が本体 HTML から頻出 n-gram を抽出し、ESC (0x1D) + index の 2 バイトトークンに置換した payload を生成。V6 が LZ 圧縮の辞書プレフィックスとして外部辞書を提供するのに対し、V7 は本体を物理的に短縮してから圧縮器に渡す補完手法）を組み合わせた最大 8 種の前処理バリアント（±A-3 × （辞書なし / V5 / V6 / V7））を生成します。その上で **6種の圧縮器**（CompressionStream系: zstd / Brotli / deflate-raw / gzip、CDNロード: **LZMA** / **brotli-wasm quality 11**）と並列に組み合わせ、合計最大 48 候補のうちペイロードが最短になったものを採用します。URLプレフィックス形式は `[<digit>]<letter>=<payload>` で、digit=辞書バージョン（省略=辞書なし / 1〜5=静的辞書 / 6=V5静的+動的辞書 / 7=V7 SDHT 本体内置換）、letter=圧縮形式（小文字=A-3なし / 大文字=A-3あり）です。V6 はペイロード先頭に varint で動的辞書長を埋め込みます（1〜2 バイトのオーバーヘッド）。例: `#b=` Brotli辞書なし / `#B=` Brotli+A-3 / `#5b=` Brotli+静的辞書v5 / `#5B=` Brotli+A-3+静的辞書v5 / `#6b=` Brotli+V5静的+動的辞書 / `#6B=` Brotli+A-3+V5静的+動的辞書 / `#7b=` Brotli+V7 SDHT / `#7B=` Brotli+A-3+V7 SDHT（過去URL `#1B=` `#2B=` `#3B=` `#4B=` `#5B=` も常にデコード可）。外部サービスを一切経由せず、ブラウザ内蔵の `CompressionStream` API と CDN ロードする LZMA-JS・brotli-wasm のみで動作します。圧縮率は内容に依存しますが、典型的には元URLの **8〜25%程度**（V6 動的辞書でコンテンツ依存パターンが多いアーティファクトは V5 よりさらに 5〜15% 縮む期待値）まで縮みます
- `hashchange` イベントに対応しており、URL書き換えで即反映されます（リロード不要）
- 多スライド・多ページ処理中はツールバーに進捗バーを表示します

## 使い方

**AI に「公開URL の `#` 以降に HTML をそのまま書いた完成URL を1本返して」と頼む**のが主な使い方です。返ってきた URL をクリックすればビューアが即座にアーティファクトを表示し、ツールバーから HTML / PNG / PDF / PPTX として保存できます。

エンコードは基本的に不要です。ビューア側が生HTMLを受け取って表示するため、AI に `encodeURIComponent` 相当の処理を要求する必要はありません（CSS の `width:100%;` のような生 `%` も壊れません）。ただし HTML 中に `#` を含めたい場合のみ `%23` に置換してください（`#` 以降の最初の `#` でフラグメントが切れるため）。日本語や空白はブラウザがアドレスバー表示上で自動エンコードしますが、ビューア側で適切に復元します。

完成URL の形式：

    https://anomori.github.io/url-to-artifact/#<HTMLをそのまま書く>

例：

    https://anomori.github.io/url-to-artifact/#<h1>Hello</h1><p>本文</p>

プロンプト例：

    https://anomori.github.io/url-to-artifact/# の後ろに、
    以下の要件のHTMLをそのまま連結した完成URL を1本だけ返してください。
    エンコードは不要です（HTML中に # を含める場合のみ %23 に置換）。
    
    要件：
    - 〇〇について説明する1枚のスライド風アーティファクト
    - インラインCSSのみ

ビューア側のフォールバック：URLハッシュを `decodeURIComponent` で解釈し、失敗した場合は孤立した `%` を `%25` にエスケープして再試行し、それでも失敗したら生文字列としてそのまま表示します。雑なURLでも極力表示を試みます。

## 技術スタック

- 静的 HTML（`index.html`）と静的辞書ファイル（`dicts.js`、V1～V5 を包含、約 8.5 KB）・動的辞書ロジック（`dynamic-dict.js`、V6 の n-gram 抽出 + varint コーデック、約 6 KB）と SDHT 本体内トークン置換ロジック（`sdht.js`、V7 の反復 n-gram 抽出 + ESC トークン置換 + varint コーデック、約 6 KB）の 4 ファイル構成で、外部 CSS は不要です（静的辞書は拡張可能設計で新バージョン追加は `dicts.js` の編集のみで完結します。動的辞書は HTML 本体から自動構築されるためファイル更新不要です）
- 表示は `<iframe srcdoc>` + sandbox で分離しています
- エクスポート用の外部ライブラリは、**初回使用時のみ**CDNから遅延読み込みします
    - html2canvas 1.4.1  — DOM → Canvas
    - jsPDF 2.5.1        — Canvas → PDF
    - pptxgenjs 3.12.0   — Canvas → PPTX
    - JSZip 3.10.1       — 複数 PNG を ZIP アーカイブ化
    - LZMA-JS 2.3.2      — LZMA圧縮/展開（Copy Short URL用、約85KB minified）
    - brotli-wasm 3.0.0  — Brotli quality 11 圧縮/展開（Copy Short URL用、DecompressionStream非対応ブラウザでのフォールバック展開にも使用）
- 初期表示ではライブラリを読み込まないため軽量です

## URL長の実用上限

| ブラウザ      | アドレスバー表示 |
| ----------- | ------------ |
| Chrome / Edge | 約 32 KB    |
| Firefox     | 64 KB        |
| Safari      | 約 80 KB    |

`#` 以降はサーバに送信されないため、サーバ側のURL長制限は無関係です。これを超えるアーティファクトは Gist / pastebin / S3 等の外部ストレージ連携が必要になります。

## セキュリティ

iframe の sandbox 属性には以下のトークンを付与しています：

- `allow-scripts`        — アーティファクト内のJS実行
- `allow-forms`          — フォーム送信
- `allow-modals`         — alert / confirm 等
- `allow-popups`         — 新規ウィンドウ起動
- `allow-downloads`      — アーティファクト内部からのダウンロード許可（Chrome 83+仕様）
- `allow-same-origin`    — html2canvas がiframe内 DOM を読むために必要

**重要**：MDNによると `allow-scripts` と `allow-same-origin` の併用は、サンドボックス保護をほぼ無効化させます（アーティファクトがホストと同一オリジンとして振る舞います）。

本ツールは「自分で生成したHTMLを表示・保存する」用途を前提としているため許容していますが、以下にご注意ください：

- 信頼できない第三者から受け取ったHTMLは貼らないでください（共有用途で受け取った URL も、送り主が信頼できる場合のみ開いてください）
- アーティファクトと同一オリジンに、Cookie やセッションを共有するセンシティブなサービスを置かないでください（GitHub Pages の場合、専用のリポジトリ・専用アカウントで隔離するとより安全です）

## 既知の制限

- PNG / PDF / PPTX は html2canvas のレンダリング結果に依存するため、Webフォント・複雑なCSS・CORS制約下の外部画像などが完全再現されないことがあります
- PPTX / PDF の多ページ化は以下の構造を自動検出します
    - reveal.js (`Reveal.getSlides()` と `Reveal.slide(h,v,f)` を利用し、`transition: none` で巡回します)
    - 汎用の複数 `<section>` ・`.slide`（`body > section` / `.marpit > section` / `main > section` / `.slides > section` 他）
    - body 直下に 2 個以上の `<hr>` があるケース（Markdown の `---` をそのまま HTML化したようなスライドデッキ）
    - 上記のいずれにも当てはまらないクラス名がユニークなSPA型スライドサイトは認識されず、ビュー全体を 1 枚の画像として出力されます
- PNG はスライドが検出された場合は ZIP（連番付きPNGをアーカイブ）、検出されない単一アーティファクトはそのまま 1 枚の PNG として保存します
- プレゼンではない通常のアーティファクト（記事・ツール・1枚ダッシュボード等）もそのままサポートしており、PDF はキャンバスの縦横比から A4の向きを自動で選択し、長辺方向にページ分割して読みやすく出力します（縦長・横長・どちらも可）
- PPTX の出力モードは 2 種類あります（自動判定）
    - **編集可能モード**（Marpit形式の `body > section` / `.marpit > section` / `main > section` を 2 枚以上検出した場合）：DOM要素の位置を `getBoundingClientRect` で実測し、見出し・段落・リスト・表・画像・`hr` をネイティブPPTX要素として配置します。`<div>` だけで構成されたカードグリッドやタイムラインなども、テキストを持つ要素ごとに自動分割して個別配置します。文字色・背景色・フォントサイズ・太字・斜体・下線・取り消し線・ハイパーリンクを反映します。PowerPoint上で文字編集・検索・読み上げが可能です
    - 編集可能モードで再現できないCSS・概念は以下のとおりです：
        - スライド背景の `linear-gradient` / `radial-gradient`（pptxgenjs はスライド背景に単色か画像しか使えないため、無視されて単色背景になります）
        - `border-radius`（PPTXのテキストボックスは角丸非対応）
        - `box-shadow` / `backdrop-filter: blur(...)` / `filter` / `mask`
        - `transform` の `rotate` / `skew`（`scale` のみ計測時に解除されます）
        - `display: flex` / `grid` の `gap` 概念（要素は実測座標で絶対配置されるため、各セルの位置自体は再現されますが「等間隔の余白」というレイアウト意図は失われます）
        - 半透明色（`rgba` の alpha < 1）は不透明として扱われ、薄い色味に丸まります。透過の重なりが大事なデザインは画像フォールバックを推奨します
        - 疑似要素 `::before` / `::after` の生成コンテンツ（DOMに存在しないため拾えません）
        - `background-image` の画像・グラデーション（要素背景としては反映されません）
        - `<details>` / `<summary>` の開閉や、`<svg>` のインラインベクター描画（テキスト部分は拾いますが図形は拾えません）
        - Webフォント（システムにないフォント名はPowerPoint側でフォールバックされます）
    - **画像フォールバック**（reveal.js / `<hr>` 区切り / 自由構造）：html2canvas で各スライドをPNG化して貼り付けます。見た目は元のCSSをそのまま再現しますが、PowerPoint上での文字編集はできません
    - 用途別の使い分けの目安：レイアウト fidelity を最優先したい（グラデーション背景・複雑な装飾を再現したい）場合は `<hr>` 区切りや reveal.js を使って画像フォールバックに倒す、文字を後から編集したい場合は `<section>` 構造に倒す、と方針を分けると安定します
- PPTX はプレゼンでないアーティファクトも 1 スライドの画像として出力可能ですが、スライド形状の都合で縦長コンテンツは小さく見えるため、長尺は PDF を推奨します
- **アーティファクト内のフラグメントリンク（目次・脚注等）の取り扱い**：AI が生成した HTML に `<a href="#math">` のような目次リンクが含まれていると、過去には iframe 内のクリックがビューア親ウィンドウの URL を書き換えてしまい、`#math` という短い hash を新しい HTML として解釈し直して「math だけが表示される」事故が起きていました。現在は二段構えで防御しています：
    - **Layer 1**：iframe document の click を capture phase で横取りし、`<a href="#...">` の既定動作を `preventDefault()` で抑止して iframe 内 `scrollIntoView({behavior:'smooth'})` に振り替えます。`<base target="_top">` を含む AI 生成 HTML でもナビゲーションごと止まります。修飾キー付きクリック (Ctrl/Cmd/Shift/Alt) と中クリックはブラウザ既定 (新規タブで開く等) に任せます
    - **Layer 2**：それでも親 URL が書き換わったケース（JS で `parent.location.hash` を直接書き換える HTML 等）に備え、`hashchange` イベントで「iframe 内に該当 id を持つ要素が実在する短い hash」は再描画せず `history.replaceState` で元の URL に戻して iframe 内スクロールにフォールバックします。実在 id 判定を伴うため、別アーティファクトをハッシュ経由で開く通常用途は妨げません
- CDN が落ちている時は PNG / PDF / PPTX エクスポートが失敗します（HTMLエクスポートはオフラインでも動作します）
- URL長上限を超える大規模アーティファクトは Gist 連携等の別経路が必要です
- `navigator.clipboard.writeText` は HTTPS / localhost 上でのみ動作します（GitHub PagesはHTTPSなので問題ありません）
- Copy Short URL の圧縮パイプライン詳細
    - **A-1 HTML ミニファイ**（常時適用、表示等価）：HTML コメントを除去し、連続空白を 1 個のスペースに圧縮し、タグ境界の空白を除去します。加えて `<style>` 内の CSS を多段階に圧縮し（コメント除去・空白圧縮・セレクタ間の不要空白除去・`#ffffff` → `#fff` ショートハンド化・`0px`→`0` の単位除去・`0.5`→`.5` の先頭ゼロ除去・`font-weight:bold`→`700` / `font-weight:normal`→`400` ショートハンド化・`rgba(0,0,0,1)`→`#000` / `rgba(255,255,255,1)`→`#fff` / alpha=0→`transparent`・`margin/padding:0 0 0 0`→`0` の shorthand 集約・`outline:none`→`outline:0` / `border:none`→`border:0` / `border-{side}:none`→`:0`・セレクタ・関数引数・複数値プロパティのコンマ前後空白除去・末尾セミコロン除去 (`;}`→`}`)）、冗長な `type="text/javascript"` / `type="text/css"` 属性を除去し、boolean 属性（`checked="checked"` → `checked` 等）を短縮し、オプショナル閉じタグ (`</p>`/`</li>`/`</td>`/`</tr>`/`</html>`/`</head>`/`</body>` 等) を除去し、値が英数字・ハイフン・ドット・アンダースコアのみの属性値は引用符を省略し、`<button type=submit>` / `<input type=text>` のデフォルト type を除去します。さらに **HTML エンティティ正規化** (`&apos;` → `&#39;` で1バイト短縮、表示等価) と **属性アルファベット順ソート** （例: `<a href="#" class="btn">` → `<a class=btn href="#">`、表示等価だが LZ 系圧縮の反復パターン一致率が上がる）も適用します。`<pre>` / `<textarea>` / `<script>` / `<style>` / `<code>` の内部はユニークマーカーで退避して完全保護するため、コードハイライトや整形済みテキストは壊れません。条件付きコメント（`<!--[if IE]>`）は保持します
    - **A-3 静的辞書置換**（試行のみ、決定的に有利な場合のみ採用）：`<!DOCTYPE html>` `<meta charset="UTF-8">` `<meta name="viewport" ...>` `justify-content:` `background-color:` `border-radius:` `align-items:` `font-weight:` `text-align:` `font-size:` `</section>` `</script>` `</button>` `</header>` 等の HTML/CSS 頻出トークン 28 種類を、NUL/TAB/LF/CR を避けた 0x01〜0x1F の制御文字 1 バイトに置換します。元 HTML がいずれかの制御文字を既に含んでいる場合は適用不可（その場合は dict なし版のみ採用）。decoder は同じテーブルで逆処理します
    - **カスタム静的辞書プレフィックス**（試行のみ、バージョン管理された拡張可能設計）：HTML/CSS/JS で頻出するパターン（典型的な `<!DOCTYPE html><html lang=en><head>...` ボイラープレート、CSS プロパティ群 `display:flex;align-items:center;...` `display:grid` `position:sticky` `inset:0` 等のモダン CSS パターン、DOM 操作パターン `document.querySelector("...` `classList.toggle("...` `getAttribute("...` `()=>{...` arrow 関数、頻出 SVG 属性パターン 等）を辞書文字列としてデータ先頭に付加してから圧縮します。現在の辞書は V1 (約 2 KB)、V2 (minify強化後、約 2.5 KB)、V3 (属性ソート対応 + モダン CSS / arrow JS 強化、約 3 KB)、V4 (V3 + 日本語頻出フレーズ・UI 命令文・HTML × 日本語ボタン/見出し、約 5 KB)、V5 (V4 + 接続表現/敬語定型・カタカナ外来語(長語)・ウェブフォーム定型・ドキュメント構造・プログラミング和訳・HTML × 日本語閉じタグ部分マッチ・絵文字 × 日本語・数字 × 日本語、約 8.5 KB) の 5 世代で、新規圧縮は最新の V5 を使用します。Brotli の組み込み静的辞書 (RFC 7932) は日本語非対応のため、V5 は特に Brotli/zstd/LZMA で日本語コンテンツ・カタカナ外来語の圧縮率向上が見込めます。辞書本体は `dicts.js` に分離されており、新バージョン追加は `dicts.js` の編集のみで完結します（`index.html` への変更不要）。LZ 系圧縮のスライディングウィンドウ内に辞書パターンが配置されるため、実データ中のマッチが後方参照で効率よく符号化されます（Brotli/zstd/LZMA は 8 MB+ ウィンドウ、deflate-raw/gzip は 32 KB ウィンドウを持ち、辞書はどちらも参照可能なサイズに収めてあります）。辞書はバージョン管理された配列 (`CUSTOM_DICTS`) で管理され、新バージョンは末尾に追加するだけで拡張可能です。旧辞書は削除されないため、過去の URL (`#1B=...` `#2B=...` `#3B=...` 等) は常にデコード可能です。URL プレフィックスの数字部分（`1b=`, `2B=`, `3B=`, `4B=` 等）がバージョンを示し、デコーダは自動的に正しい辞書を選択します
    - **V6 動的辞書**（試行のみ、コンテンツ依存でランタイム構築）：`dynamic-dict.js` がミニファイ済み HTML 本体から頻出 n-gram（長さ 5〜32 バイト × 9 段階）を抽出し、スコア = (頻度−1) × max(0, 長さ−3) で評価して貪欲選択したコンテンツ依存辞書をランタイム構築します。辞書サイズは本体長に応じて動的に選択（1 KB 未満=辞書なし / 1〜5 KB=128 B / 5〜15 KB=256 B / 15〜50 KB=512 B / 50 KB+=1024 B）され、V5 静的辞書と併用して「V5 静的 + 動的 + 本体」の 3 段プレフィックスを圧縮します。URL ペイロード先頭に varint（LEB128 unsigned, 1〜2 バイト）で動的辞書長を埋め込み、デコーダはその長さだけ slice して本体を復元します。Brotli の組み込み静的辞書 (RFC 7932) がカバーしない「そのアーティファクトに固有の反復パターン」（独自 CSS クラス名、テンプレート化されたJSブロック、反復するカード構造等）を捕らえるため、コンテンツ依存パターンが多いアーティファクトで V5 よりさらに 5〜15% 圧縮率が上がります。`dynamic-dict.js` のロードに失敗した際は V6 を候補から除外して V5 までで動作を継続します
    - **V7 SDHT**（試行のみ、本体内トークン置換）：`sdht.js` がミニファイ済み HTML 本体から反復 n-gram（長さ 5〜32 バイト × 9 段階）を抽出し、スコア = freq × (len - 2) - (len + 1) で評価して貪欲選択した上で、各パターンを ESC (0x1D) + 1 バイトインデックスの 2 バイトトークンに置換します。本体内のリテラル 0x1D は ESC + 0xFE で保護されます。テーブルサイズは本体長に応じて 32〜254 エントリで動的選択（1 KB 未満=なし / 1〜5 KB=32 / 5〜15 KB=64 / 15〜50 KB=128 / 50 KB+=254）。ペイロード形式は `varint(N) + N × (varint(len) + len units) + transformedBody` で、varint は LEB128 unsigned (1〜2 バイト) です。V6 が LZ 圧縮の辞書プレフィックスとして外部辞書を提供するのに対し、V7 は本体を物理的に短縮してから圧縮器に渡すため、両者は補完関係にあります。LZ 窓を超える長距離反復や、LZ77 の最小マッチ長 (約 3 バイト) より短い高頻度パターンを直接削減するため、特に大規模ファイルで効果が見込めます。`sdht.js` のロードに失敗した際は V7 を候補から除外して V1〜V6 で動作を継続します
    - **圧縮器は 6 種を並列試行**：CompressionStream 系（zstd / Brotli / deflate-raw / gzip）、LZMA-JS（CDN 遅延ロード）、および **brotli-wasm quality 11**（CDN 遅延ロード）を、前処理バリアント（±A-3 × （辞書なし / V5 静的 / V6 V5静的+動的 / V7 SDHT 本体内置換））と組み合わせて最大 48 候補を `Promise.all` で並列圧縮し、出力ペイロードが最短になったものを採用します。brotli-wasm は CompressionStream('brotli') のデフォルト品質（4〜6相当）より高い quality 11（最大）で圧縮するため、10〜25% の追加圧縮が見込めます。出力は標準 Brotli ストリームのため DecompressionStream('brotli') 対応ブラウザではネイティブ展開され、非対応ブラウザでは brotli-wasm 自体でフォールバック展開されます
    - 形式と対応ブラウザ
        - zstd (`#s=` / `#S=` 形式)：CompressionStream API としては現状 Firefox 149+ のみ対応。zstd の HTTP コンテンツエンコーディング対応とは別物で、Chrome / Safari / Edge は未対応です
        - Brotli (`#b=` / `#B=` 形式、カスタム辞書付きは `#1b=` / `#1B=` 等)：Chrome 144+ / Edge 144+ / Firefox 147+ / Safari 19+ でネイティブ展開。非対応ブラウザでも brotli-wasm によるフォールバック展開が可能なため、実質すべてのモダンブラウザで開けます。brotli-wasm quality 11 で圧縮した場合もネイティブ Brotli と同一フォーマットです
        - deflate-raw (`#d=` / `#D=` 形式)：全主要ブラウザ（Chrome 80+ / Edge 80+ / Firefox 113+ / Safari 16.4+）。gzip と同じ DEFLATE 圧縮だがヘッダ・チェックサムが無いため、同じ内容なら常に gzip より約 18 バイト短くなります
        - gzip (`#z=` / `#Z=` 形式)：全主要ブラウザ（Chrome 80+ / Edge 80+ / Firefox 113+ / Safari 16.4+）
        - **LZMA** (`#l=` / `#L=` 形式)：LZMA-JS（pure-JS、約 85 KB minified）を CDN（jsDelivr）から遅延ロードして使用。CompressionStream に依存しないため、対応ブラウザは実質すべてのモダンブラウザ。HTML/CSS/JS で Brotli より 5〜15% 縮むことがありますが、圧縮時間は数秒オーダーになることがあります（圧縮レベル 9 = 最大圧縮）
    - 受信側のブラウザが該当形式を未対応の状態でそのURLを開いた場合は、形式ごとに対応ブラウザを案内するエラー表示になります（LZMA URL は LZMA-JS が読めれば全ブラウザで開けます）
    - URLプレフィックス形式は `[<digit>]<letter>=<payload>` です。digit（省略可）=辞書バージョン（1〜5=静的辞書 / 6=V5静的+動的辞書 / 7=V7 SDHT 本体内置換）、letter=圧縮形式（小文字=A-3なし / 大文字=A-3あり）。旧形式（`#b=...` 等、数字なし）との後方互換性があります。`#6...` はペイロード先頭に varint で動的辞書長（最大 1024 = 1〜2 バイト）を含み、デコーダはその長さだけ展開後に slice して本体を復元します
    - 圧縮率は内容に依存しますが、典型的には元の **8〜25% 程度**（前処理 + カスタム辞書 + 最良形式の組み合わせ）まで縮みます。V6 動的辞書はコンテンツ依存パターンが多いアーティファクト（テンプレート化されたJSブロック、反復カード構造、独自 CSS クラス名等）で V5 より 5〜15% さらに縮む期待値です。バイナリ画像の dataURL 等はすでに圧縮済みのためほとんど縮みません
    - 短縮URLはブラウザ内で完結するため、外部サービス（短縮URLサービス・pastebin等）への依存・データ送信は一切ありません。LZMA-JS・brotli-wasm のロードのみ CDN（jsDelivr / unpkg）への HTTP リクエストが発生しますが、コード本体のダウンロード以外の通信は行いません