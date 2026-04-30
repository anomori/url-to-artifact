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
- Copy Short URL ボタンで、現在のアーティファクトを圧縮した短縮URLとしてクリップボードにコピーできます。圧縮前に **A-1 ミニファイ**（HTML から不要な空白とコメントを削除、表示は等価）を適用し、さらに **A-3 静的辞書置換**（`<!DOCTYPE html>` `<meta charset="UTF-8">` 等の頻出トークンを 1 バイトの制御文字に置換）を適用したものとしないものの両方を試行します。その上で **5 種の圧縮形式**（zstd / Brotli / deflate-raw / gzip / **LZMA**）と並列に組み合わせ、合計最大 10 候補のうちペイロードが最短になったものを採用します（同点時の優先順は dict なし → dict あり、形式は zstd > Brotli > deflate-raw > gzip > LZMA）。出力形式は採用された組み合わせで決まり、小文字プレフィックスが辞書なし版（`#s=` zstd / `#b=` Brotli / `#d=` deflate-raw / `#z=` gzip / `#l=` LZMA）、大文字プレフィックスが辞書あり版（`#S=` / `#B=` / `#D=` / `#Z=` / `#L=`）です。外部サービスを一切経由せず、ブラウザ内蔵の `CompressionStream` API と CDN ロードする LZMA-JS（pure-JS、約 85 KB）のみで動作します。圧縮率は内容に依存しますが、典型的には元URLの **18〜35%程度**（前処理 + 最良形式）まで縮みます
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

- 静的 HTML 1ファイル（`index.html`）で、外部 CSS / JS ファイルは不要です
- 表示は `<iframe srcdoc>` + sandbox で分離しています
- エクスポート用の外部ライブラリは、**初回使用時のみ**CDNから遅延読み込みします
    - html2canvas 1.4.1  — DOM → Canvas
    - jsPDF 2.5.1        — Canvas → PDF
    - pptxgenjs 3.12.0   — Canvas → PPTX
    - JSZip 3.10.1       — 複数 PNG を ZIP アーカイブ化
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
    - **A-1 HTML ミニファイ**（常時適用、表示等価）：HTML コメントを除去し、連続空白を 1 個のスペースに圧縮し、タグ境界の空白を除去します。`<pre>` / `<textarea>` / `<script>` / `<style>` / `<code>` の内部はホワイトスペースを完全保護するため、コードハイライトや整形済みテキストは壊れません。条件付きコメント（`<!--[if IE]>`）は保持します
    - **A-3 静的辞書置換**（試行のみ、決定的に有利な場合のみ採用）：`<!DOCTYPE html>` `<meta charset="UTF-8">` `<meta name="viewport" ...>` `</section>` `</script>` `<head>` `</head>` `<body>` `</body>` `</html>` 等の HTML 頻出トークン約 26 種類を、NUL/TAB/LF/CR を避けた 0x01〜0x1F の制御文字 1 バイトに置換します。元 HTML がいずれかの制御文字を既に含んでいる場合は適用不可（その場合は dict なし版のみ採用）。decoder は同じテーブルで逆処理します
    - **圧縮形式は 5 種を並列試行**：CompressionStream 系（zstd / Brotli / deflate-raw / gzip）と LZMA-JS（CDN 遅延ロード）を、A-3 辞書ありなしと組み合わせて最大 10 候補を `Promise.all` で並列圧縮し、出力ペイロードが最短になったものを採用します。同点時の優先順は dict なし → dict あり、形式は zstd > Brotli > deflate-raw > gzip > LZMA
    - 形式と対応ブラウザ
        - zstd (`#s=` / `#S=` 形式)：CompressionStream API としては現状 Firefox 149+ のみ対応。zstd の HTTP コンテンツエンコーディング対応とは別物で、Chrome / Safari / Edge は未対応です
        - Brotli (`#b=` / `#B=` 形式)：Chrome 144+ / Edge 144+ / Firefox 147+ / Safari 19+
        - deflate-raw (`#d=` / `#D=` 形式)：全主要ブラウザ（Chrome 80+ / Edge 80+ / Firefox 113+ / Safari 16.4+）。gzip と同じ DEFLATE 圧縮だがヘッダ・チェックサムが無いため、同じ内容なら常に gzip より約 18 バイト短くなります
        - gzip (`#z=` / `#Z=` 形式)：全主要ブラウザ（Chrome 80+ / Edge 80+ / Firefox 113+ / Safari 16.4+）
        - **LZMA** (`#l=` / `#L=` 形式)：LZMA-JS（pure-JS、約 85 KB minified）を CDN（jsDelivr）から遅延ロードして使用。CompressionStream に依存しないため、対応ブラウザは実質すべてのモダンブラウザ。HTML/CSS/JS で Brotli より 5〜15% 縮むことがありますが、圧縮時間は数秒オーダーになることがあります（圧縮レベル 9 = 最大圧縮）
    - 受信側のブラウザが該当形式を未対応の状態でそのURLを開いた場合は、形式ごとに対応ブラウザを案内するエラー表示になります（LZMA URL は LZMA-JS が読めれば全ブラウザで開けます）
    - 圧縮率は内容に依存しますが、典型的には元の **18〜35% 程度**（前処理 + 最良形式の組み合わせ）まで縮みます。バイナリ画像の dataURL 等はすでに圧縮済みのためほとんど縮みません
    - 短縮URLはブラウザ内で完結するため、外部サービス（短縮URLサービス・pastebin等）への依存・データ送信は一切ありません。LZMA-JS のロードのみ jsDelivr CDN への HTTP リクエストが発生しますが、コード本体のダウンロード以外の通信は行いません