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
- Copy URL ボタンで現在URLをクリップボードにコピーできます
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
    - **編集可能モード**（Marpit形式の `body > section` / `.marpit > section` / `main > section` を 2 枚以上検出した場合）：DOM要素の位置を `getBoundingClientRect` で実測し、見出し・段落・リスト・表・画像・`hr` をネイティブPPTX要素として配置します。文字色・背景色・フォントサイズ・太字・斜体・下線・取り消し線・ハイパーリンクを反映します。PowerPoint上で文字編集・検索・読み上げが可能です
    - **画像フォールバック**（reveal.js / `<hr>` 区切り / 自由構造）：html2canvas で各スライドをPNG化して貼り付けます。見た目は元のCSSをそのまま再現しますが、PowerPoint上での文字編集はできません
- PPTX はプレゼンでないアーティファクトも 1 スライドの画像として出力可能ですが、スライド形状の都合で縦長コンテンツは小さく見えるため、長尺は PDF を推奨します
- CDN が落ちている時は PNG / PDF / PPTX エクスポートが失敗します（HTMLエクスポートはオフラインでも動作します）
- URL長上限を超える大規模アーティファクトは Gist 連携等の別経路が必要です
- `navigator.clipboard.writeText` は HTTPS / localhost 上でのみ動作します（GitHub PagesはHTTPSなので問題ありません）