# Artifact Viewer

URLのハッシュに埋め込んだHTMLをレンダリングし、HTML / PNG / PDF / PPTX として保存できるシンプルなビューア。

## 何ができるか

- URL の `#` 以降にHTMLを書くと、その場でレンダリング
- ツールバーから現在のアーティファクトを以下の形式で保存
    - HTML — ソースをそのまま .html としてダウンロード
    - PNG  — スライド検出時は各スライドを ZIP アーカイブ、それ以外は全体1枚の PNG
    - PDF  — スライド検出時は1スライド=1ページ、長いスクロールページは A4縦に自動ページ分割（jsPDF）
    - PPTX — スライド検出時は多スライド、それ以外は1枚の16:9スライド（pptxgenjs）
- Copy URL ボタンで現在URLをクリップボードにコピー
- `hashchange` イベント対応：URL書き換えで即反映（リロード不要）

## 使い方

ホスティング先の `index.html` のURLの末尾に `#` と表示したいHTML本体を追加するだけ。例：

    https://<host>/index.html#<h1>Hello</h1><p>本文</p>

ブラウザが特殊文字を自動でURLエンコードするため、手動でエンコードする必要はない。ただし `#` をHTML中に含めたい場合のみ `%23` に置換すること。

想定ワークフロー：

1. NotionAI などのLLMでHTMLアーティファクトを生成
2. このビューアの URL の `#` 以降に貼り付け
3. 表示を確認し、必要な形式で保存

## 技術スタック

- 静的 HTML 1ファイル（`index.html`）、外部 CSS / JS ファイル不要
- 表示は `<iframe srcdoc>` + sandbox で分離
- エクスポート用の外部ライブラリは、**初回使用時のみ**CDNから遅延読み込み
    - html2canvas 1.4.1  — DOM → Canvas
    - jsPDF 2.5.1        — Canvas → PDF
    - pptxgenjs 3.12.0   — Canvas → PPTX
    - JSZip 3.10.1       — 複数 PNG を ZIP アーカイブ化
- 初期表示はライブラリを引っ張らないため軽量

## デプロイ

GitHub Pages / Cloudflare Pages / Netlify / Vercel などの静的ホスティングに `index.html` を置くだけ。ビルド手順不要。

ローカルで動作確認する場合：

    python -m http.server 8000

その後 `http://localhost:8000/index.html#<h1>test</h1>` をブラウザで開く。

## URL長の実用上限

| ブラウザ      | アドレスバー表示 |
| ----------- | ------------ |
| Chrome / Edge | 約 32 KB    |
| Firefox     | 64 KB        |
| Safari      | 約 80 KB    |

`#` 以降はサーバに送信されないため、サーバ側のURL長制限は無関係。これを超えるアーティファクトは Gist / pastebin / S3 等の外部ストレージ連携が必要。

## セキュリティ

iframe の sandbox 属性は 以下のトークンを付与している：

- `allow-scripts`        — アーティファクト内のJS実行
- `allow-forms`          — フォーム送信
- `allow-modals`         — alert / confirm 等
- `allow-popups`         — 新規ウィンドウ起動
- `allow-downloads`      — アーティファクト内部からのダウンロード許可（Chrome 83+仕様）
- `allow-same-origin`    — html2canvas がiframe内 DOM を読むために必要

**重要**：MDNによると `allow-scripts` と `allow-same-origin` の併用は、サンドボックス保護をほぼ無効化させる（アーティファクトがホストと同一オリジンとして振る舞う）。

本ツールは「自分で生成したHTMLを表示・保存する」用途を前提としているため許容しているが、以下に注意：

- 第三者から受け取ったHTMLを貼らない
- ホスティング先をメインのNotionアカウントや他の重要サービスとは別ドメインにする（専用のGitHub Pagesリポジトリを推奨）
- アーティファクトと同じオリジンにセンシティブなデータを置かない

## 既知の制限

- 画像 / PDF / PPTX は html2canvas のレンダリング結果に依存するため、Webフォント・複雑なCSS・CORS制約下の外部画像などが完全再現されないことがある
- PPTX / PDF の多ページ化は以下の構造を自動検出
    - reveal.js (`Reveal.getSlides()` と `Reveal.slide(h,v,f)` を利用し、`transition: none` で巡回)
    - 汎用の複数 `<section>` ・`.slide`（`body > section` / `main > section` / `.slides > section` 他）
    - 性能のためクラス名とセレクタ位置で検出しているため、`<hr>` 区切りのMarpスタイル・クラス名がユニークなSPA型スライドサイトは認識されず、ビュー全体を 1 枚の画像として出力される
- PNG はスライドが検出された場合は ZIP（連番付きPNGをアーカイブ）、検出されない単一アーティファクトはそのまま 1 枚の PNG として保存
- プレゼンではない通常のアーティファクト（記事・ツール・1枚ダッシュボード等）もそのままサポートされ、PDF は長尺コンテンツを A4縦に自動ページ分割して読みやすく出力する
- PPTX はプレゼンでないアーティファクトも 1 スライドの画像として出力可能（スライド形状の都合で縦長コンテンツは小さく見えるため、長尺は PDF 推奨）
- CDN が落ちている時は PNG / PDF / PPTX エクスポートが失敗する（HTMLエクスポートはオフラインでも動作）
- URL長上限を超える大規模アーティファクトは Gist 連携等の別経路が必要
- `navigator.clipboard.writeText` は HTTPS / localhost 上でのみ動作する（GitHub PagesはHTTPSなので問題なし）

## ファイル構成

    /
    ├─ index.html   メインのビューア本体
    └─ README.md   このドキュメント

## ライセンス

MIT