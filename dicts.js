// dicts.js — Custom dictionary versions for HTML compression (Copy Short URL)
//
// 各バージョンは LZ系圧縮 (Brotli / zstd / deflate-raw / gzip / LZMA) のスライディング
// ウィンドウに事前ロードされる辞書文字列。圧縮側は HTML 先頭に dict を連結してから
// 圧縮し、展開側は dict.length 分先頭から切り捨てる。これにより HTML/CSS/JS/日本語の
// 頻出パターンが LZ77 後方参照として短く符号化され、圧縮率が向上する。
//
// 追記専用 (append-only): 過去の URL は短縮プレフィックスでバージョン番号を埋め込んで
// いるため、既に流通している URL を将来も復元できるよう、旧バージョンは削除しない。
// 新バージョンは配列末尾に追加し、CURRENT_DICT_VERSION をそのインデックスに更新する。
//
// === !!! 既存バージョンの内容は絶対に変更しないこと !!! ===
// V1〜V(N-1) の文字列を 1 バイトでも変更すると、その辞書で圧縮された過去 URL は
// 展開時に dict.length が一致せず誤った位置で切断され、復号結果が文字化けする
// (index.html 側 dictPrefixStrip() は text.slice(dict.length) という固定長スライスのため)。
// タイポ修正・整形・空白追加・順序変更も全て禁止。改善したい場合は新しい VN を
// 追加する形で行う。誤って変更してしまった場合は git でリバートすること。
// 配列・オブジェクトともに Object.freeze で凍結しているが、ソース編集まで防げる
// わけではないので、運用ルールとして守る必要がある。
//
// V1: 初版 (line-height:1.5、border-radius:8px 等の基本HTML/CSSパターン)
// V2: minifyHtml 強化後のパターン (引用符省略・オプショナルタグ除去・CSS短縮後の形式)
// V3: 属性アルファベット順ソート対応 + display:grid/sticky position/inset 等の
//     モダンCSSパターン強化 + JS arrow 短縮 (=>{...) と頻出メソッド
//     (classList.toggle, getAttribute 等) 拡充。約 3KB。
// V4: V3 に日本語の高頻度フレーズ・UI 命令文・HTML × 日本語ボタンラベル・見出しを追加。
//     ターゲット: 日本語コンテンツを含む artifact (説明文、UIラベル、見出し)。
//     Brotli の組み込み静的辞書 (RFC 7932) は英・西・中・露・ヒ・ア対応で日本語非対応
//     のため、特に Brotli/zstd/LZMA で効果が大きい。約 5KB。
// V5: V4 + 拡張 8 カテゴリ (接続表現/敬語定型・カタカナ外来語(長語)・ウェブフォーム定型・
//     アーティファクト/プレゼン/ドキュメント構造・プログラミング和訳・HTML×JP 閉じタグ
//     部分マッチ・絵文字×JP・数字×JP)。LZ77 は長いマッチほど後方参照が効率的になるため、
//     特にカタカナ外来語 (5+字) で利得が大きい。重複は LZ ウィンドウ内で同位置とみなされる
//     ため V4 既出フレーズは入れていない。最頻出カテゴリ (カタカナ) を末尾配置することで
//     LZ77 の recency bias を活かしている。約 8.5KB。
//
// === 拡張ガイド ===
// 新バージョンを追加する場合:
//   1. 末尾に const VN = ... を定義 (旧 VM をベースに ' + ... ' で append すると差分のみ書ける)
//   2. CUSTOM_DICTS 配列の末尾に VN を追加
//   3. CURRENT_DICT_VERSION を N に更新
// index.html 側のコード変更は不要。窓サイズの上限 (deflate=32KB) を超えないよう、
// V_total + 圧縮前 HTML が 32KB 以内に収まる範囲で追加すること (Brotli/zstd/LZMA は
// 8MB+ なので実質無制限)。

window.UAT_DICTS = (() => {
  const V1 = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title></title><style>*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#333;background:#fff}'
    + '.container{max-width:1200px;width:100%;margin:0 auto;padding:0 20px}'
    + 'display:flex;align-items:center;justify-content:center;justify-content:space-between;'
    + 'flex-direction:column;flex-direction:row;position:relative;position:absolute;'
    + 'font-size:16px;font-size:14px;font-size:24px;font-size:12px;font-size:20px;'
    + 'font-weight:bold;font-weight:600;font-weight:700;'
    + 'text-align:center;text-align:left;color:#333;color:#666;color:#fff;color:inherit;'
    + 'background-color:#fff;background-color:#f5f5f5;background-color:transparent;'
    + 'border-radius:8px;border-radius:4px;border-radius:12px;border-radius:50%;'
    + 'padding:4px;padding:8px;padding:12px;padding:16px;padding:20px;padding:24px;'
    + 'margin:0 auto;margin:0;margin-bottom:;margin-top:;'
    + 'width:100%;height:100%;max-width:;min-height:100vh;overflow:hidden;overflow:auto;'
    + 'border:none;border:1px solid #ddd;border:1px solid #eee;border-bottom:1px solid;'
    + 'box-shadow:0 2px 4px rgba(0,0,0,0.1);box-shadow:0 4px 6px rgba(0,0,0,0.1);'
    + 'transition:all 0.3s ease;transition:all 0.2s;transform:translateX(;transform:translateY(;'
    + 'opacity:0;opacity:1;cursor:pointer;gap:4px;gap:8px;gap:12px;gap:16px;gap:24px;'
    + 'z-index:;white-space:nowrap;text-overflow:ellipsis;text-decoration:none;'
    + 'grid-template-columns:;@media(max-width:768px){</style></head><body>'
    + '<div class="container"><div class=""><span class=""><button class="">'
    + '<a href="#" class=""><img src="" alt=""><input type="text" class="">'
    + '<h1 class=""><h2 class=""><h3 class=""><p class=""><section class="">'
    + '</div></span></button></a></li></ul></h1></h2></h3></p></section></header></footer>'
    + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M</svg>'
    + 'addEventListener("DOMContentLoaded",function(){'
    + 'addEventListener("click",function(e){e.preventDefault();'
    + 'document.querySelector(".document.querySelectorAll(".'
    + 'document.getElementById("classList.add("classList.remove("'
    + 'style.display="innerHTML="textContent="'
    + 'function(){return}const =>{Math.floor(Math.random()*'
    + 'JSON.stringify(JSON.parse(console.log("'
    + '<\/script><\/body><\/html>';

  // V2: minifyHtml 強化後のパターン (引用符省略・オプショナルタグ除去・CSS短縮後の形式)
  const V2 = '<!DOCTYPE html><html lang=en><head><meta charset=UTF-8>'
    + '<meta name=viewport content="width=device-width,initial-scale=1">'
    + '<title></title><style>*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#333;background:#fff}'
    + '.container{max-width:1200px;width:100%;margin:0 auto;padding:0 20px}'
    + 'display:flex;align-items:center;justify-content:center;justify-content:space-between;'
    + 'flex-direction:column;flex-direction:row;position:relative;position:absolute;'
    + 'font-size:16px;font-size:14px;font-size:24px;font-size:12px;font-size:20px;'
    + 'font-weight:700;font-weight:600;font-weight:400;'
    + 'text-align:center;text-align:left;color:#333;color:#666;color:#fff;color:inherit;'
    + 'background-color:#fff;background-color:#f5f5f5;background-color:transparent;'
    + 'border-radius:8px;border-radius:4px;border-radius:12px;border-radius:50%;'
    + 'padding:4px;padding:8px;padding:12px;padding:16px;padding:20px;padding:24px;'
    + 'margin:0 auto;margin:0;margin-bottom:;margin-top:;'
    + 'width:100%;height:100%;max-width:;min-height:100vh;overflow:hidden;overflow:auto;'
    + 'border:none;border:1px solid #ddd;border:1px solid #eee;border-bottom:1px solid;'
    + 'box-shadow:0 2px 4px rgba(0,0,0,.1);box-shadow:0 4px 6px rgba(0,0,0,.1);'
    + 'transition:all .3s ease;transition:all .2s;transform:translateX(;transform:translateY(;'
    + 'opacity:0;opacity:1;cursor:pointer;gap:4px;gap:8px;gap:12px;gap:16px;gap:24px;'
    + 'z-index:;white-space:nowrap;text-overflow:ellipsis;text-decoration:none;'
    + 'display:grid;display:none;flex-wrap:wrap;list-style:none;border-collapse:collapse;'
    + 'grid-template-columns:;@media(max-width:768px){</style><body>'
    + '<div class="container"><div class=""><span class=""><button class="">'
    + '<a href="#" class=""><img src="" alt=""><input class="">'
    + '<h1 class=""><h2 class=""><h3 class=""><p class=""><section class="">'
    + '</div></span></button></a></ul></h1></h2></h3></section></header></footer>'
    + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill=none '
    + 'stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round>'
    + '<path d="M</svg>'
    + 'addEventListener("DOMContentLoaded",function(){'
    + 'addEventListener("click",function(e){e.preventDefault();'
    + 'document.querySelector(".document.querySelectorAll(".'
    + 'document.getElementById("classList.add("classList.remove("'
    + 'style.display="innerHTML="textContent="'
    + 'function(){return}const =>{Math.floor(Math.random()*'
    + 'JSON.stringify(JSON.parse(console.log("'
    + '<\/script>';

  // V3: 属性アルファベット順ソート対応 + display:grid/sticky position/inset 等のモダンCSSパターン強化
  // + JS arrow 短縮 (=>{...) と頻出メソッド (classList.toggle, getAttribute 等) 拡充。
  const V3 = '<!DOCTYPE html><html lang=en><head><meta charset=UTF-8>'
    + '<meta content="width=device-width,initial-scale=1" name=viewport>'
    + '<title></title><style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{background:#fff;color:#333;font-family:system-ui,-apple-system,sans-serif;line-height:1.5}'
    + '.container{margin:0 auto;max-width:1200px;padding:0 20px;width:100%}'
    + 'display:flex;display:grid;display:none;display:block;display:inline-block;display:inline-flex;'
    + 'align-items:center;align-items:flex-start;align-items:flex-end;align-items:stretch;'
    + 'justify-content:center;justify-content:space-between;justify-content:flex-start;justify-content:flex-end;justify-content:space-around;'
    + 'flex-direction:column;flex-direction:row;flex-wrap:wrap;flex:1;flex-grow:1;flex-shrink:0;'
    + 'position:relative;position:absolute;position:fixed;position:sticky;'
    + 'top:0;left:0;right:0;bottom:0;inset:0;'
    + 'font-size:12px;font-size:14px;font-size:16px;font-size:18px;font-size:20px;font-size:24px;font-size:28px;font-size:32px;'
    + 'font-weight:400;font-weight:500;font-weight:600;font-weight:700;font-weight:800;'
    + 'text-align:center;text-align:left;text-align:right;text-align:justify;'
    + 'color:#000;color:#333;color:#555;color:#666;color:#888;color:#999;color:#fff;color:inherit;'
    + 'background:#fff;background:#000;background:#f5f5f5;background:#fafafa;background:transparent;'
    + 'background-color:#fff;background-color:#f5f5f5;background-color:transparent;'
    + 'border-radius:4px;border-radius:6px;border-radius:8px;border-radius:12px;border-radius:16px;border-radius:50%;border-radius:9999px;'
    + 'padding:4px;padding:8px;padding:12px;padding:16px;padding:20px;padding:24px;padding:32px;'
    + 'padding:0 8px;padding:0 16px;padding:0 20px;padding:8px 16px;padding:12px 24px;'
    + 'margin:0 auto;margin:0;margin:8px;margin:16px;margin-bottom:8px;margin-bottom:16px;margin-bottom:24px;margin-top:0;margin-top:16px;'
    + 'width:100%;height:100%;max-width:100%;min-height:100vh;height:100vh;'
    + 'overflow:hidden;overflow:auto;overflow:scroll;overflow-x:auto;overflow-y:auto;'
    + 'border:0;border:1px solid #ddd;border:1px solid #eee;border:2px solid;border-bottom:1px solid #eee;border-top:1px solid #eee;'
    + 'box-shadow:0 1px 2px rgba(0,0,0,.05);box-shadow:0 1px 3px rgba(0,0,0,.1);box-shadow:0 2px 4px rgba(0,0,0,.1);box-shadow:0 4px 6px rgba(0,0,0,.1);box-shadow:0 10px 15px rgba(0,0,0,.1);'
    + 'transition:all .2s;transition:all .3s ease;transition:transform .3s;transition:opacity .2s;transition:background .2s;'
    + 'transform:translateX(0);transform:translateY(0);transform:scale(1);transform:rotate(0);transform:translate(-50%,-50%);'
    + 'opacity:0;opacity:.5;opacity:.7;opacity:.8;opacity:1;cursor:pointer;cursor:default;cursor:not-allowed;'
    + 'gap:4px;gap:8px;gap:12px;gap:16px;gap:20px;gap:24px;gap:32px;'
    + 'z-index:0;z-index:1;z-index:10;z-index:100;z-index:999;z-index:9999;'
    + 'white-space:nowrap;text-overflow:ellipsis;text-decoration:none;text-decoration:underline;'
    + 'list-style:none;border-collapse:collapse;line-height:1;line-height:1.2;line-height:1.5;line-height:1.6;'
    + 'grid-template-columns:repeat(2,1fr);grid-template-columns:repeat(3,1fr);grid-template-columns:repeat(4,1fr);grid-template-columns:1fr 1fr;'
    + '@media (max-width:768px){@media (min-width:768px){@media (max-width:1024px){@media print{'
    + '</style><body>'
    + '<div class=container><div class=row><div class=col>'
    + '<div class=card><div class=header><div class=footer><div class=content><div class=wrapper><div class=section>'
    + '<span class=label><span class=icon><button class=btn type=button>'
    + '<a class=link href="#"><a href="#">'
    + '<img alt="" src=""><input name="" placeholder="">'
    + '<h1 class=""><h2 class=""><h3 class=""><p class=""><section class="">'
    + '</a></button></div></h1></h2></h3></p></section></span></ul></ol>'
    + '<svg fill=none height=24 stroke=currentColor stroke-linecap=round stroke-linejoin=round stroke-width=2 viewBox="0 0 24 24" width=24 xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M</svg>'
    + 'addEventListener("DOMContentLoaded",()=>{'
    + 'addEventListener("click",e=>{e.preventDefault();'
    + 'document.querySelector(".document.querySelectorAll(".'
    + 'document.getElementById("classList.add("classList.remove("classList.toggle("classList.contains("'
    + 'style.display=innerHTML="textContent="setAttribute("getAttribute("'
    + 'JSON.stringify(JSON.parse(console.log("console.error("Math.floor(Math.random()*Math.PI*Math.max(Math.min('
    + 'forEach((,i)=>{filter(=>{map(=>{reduce((,b)=>{const = =>{return}let =0;'
    + 'function(){return}=>{}=>{return}'
    + '<\/script>';

  // V4: V3 + 日本語頻出フレーズ。append-only なので V3 に存在する全パターンも引き続き利用可能。
  // ブロックは「文末表現」「連結フレーズ」「接続表現」「接続詞」「指示語」「UI 命令文」
  // 「エラー・状態文」「HTML × ボタンラベル」「HTML × 見出し」「記号」の順で並べ、
  // LZ ウィンドウ末尾に近いほど（=圧縮対象本文に物理的に近いほど）優先度が高くなるよう
  // 期待頻度の高いパターンを後方に置いている。
  const V4 = V3
    // 文末表現 (sentence-ending copulas/auxiliaries)
    + 'です。ます。でした。ました。ません。でしょう。である。だろう。ですね。ですが、'
    + 'します。しました。しません。しています。していました。'
    // 高頻度連結フレーズ (compound expressions, very common in Japanese prose)
    + 'することができます。することができる。することがあります。'
    + 'ことができます。ことができる。ことがあります。ことになります。'
    + 'ということです。ということ、ということが、ということを、'
    + 'ようになります。ようになる。ようにする。ようにします。'
    + 'と思います。と考えられます。と言えます。'
    // 接続表現 (case markers + verbs, very common phrases)
    + 'について、として、における、における。による、によって、'
    + 'に対して、に関して、に基づいて、に応じて、によると、'
    + 'のように、のために、の場合は、の場合、のとき、の中で、'
    // 接続詞 (sentence-initial conjunctions)
    + 'しかし、そして、また、つまり、なお、さらに、ただし、'
    + 'または、もしくは、および、ならびに、なぜなら、'
    + 'たとえば、具体的には、一般に、特に、通常、'
    // 指示語・限定 (demonstratives and quantifiers)
    + 'これは、それは、このような、そのような、すべての、'
    + 'これらの、それらの、各種の、様々な、多くの、'
    // UI 命令文 (imperative UI text — common in artifacts/forms)
    + 'クリックしてください。選択してください。入力してください。'
    + '確認してください。送信してください。お待ちください。'
    + 'もう一度お試しください。'
    // エラー・状態文 (status/error messages)
    + '正常に完了しました。エラーが発生しました。'
    + '準備中です。読み込み中…保存しました。削除しました。'
    + 'よろしいですか？削除してもよろしいですか？'
    // HTML × ボタンラベル (button text fragments — match adjacent tags too)
    + '<button>確認</button><button>キャンセル</button>'
    + '<button>送信</button><button>保存</button>'
    + '<button>削除</button><button>編集</button>'
    + '<button>追加</button><button>更新</button>'
    + '<button>戻る</button><button>閉じる</button>'
    + '<button>新規作成</button><button>詳細</button>'
    // HTML × 見出し (heading text fragments)
    + '<h1>概要</h1><h1>はじめに</h1><h2>使い方</h2>'
    + '<h2>機能</h2><h2>特徴</h2><h2>注意事項</h2><h3>例</h3>'
    + '<h2>目次</h2><h2>まとめ</h2><h2>参考</h2>'
    // 句読点・記号 (punctuation symbols frequently appearing in JP text)
    + '、。「」『』・※→⇒…';

  // V5: V4 + 拡張 8 カテゴリ。経験的優先度に基づき後方ほど高頻度を配置。
  // - 2-A 接続表現・敬語定型: 長文連結フレーズ (10〜21 バイト級)
  // - 2-E プログラミング和訳: コード解説アーティファクトで頻出
  // - 2-D アーティファクト/プレゼン/ドキュメント構造: 章節定型
  // - 2-H 数字 + 日本語: 章番号・箇条書き
  // - 2-C ウェブフォーム定型: NotionAI 生成 HTML で頻出
  // - 2-F HTML × 日本語 閉じタグ: 部分マッチで広く効く (V4 は完全タグのみ)
  // - 2-G 絵文字 × 日本語: 1 マッチで 10〜13 バイト稼げる
  // - 2-B カタカナ外来語: 現代日本語の約 30% を占める最頻出カテゴリ。
  //   長語 (5+字) は LZ77 後方参照で最も得しやすいため最末尾配置。
  // 区切りは「、」を使用。LZ77 は任意位置から match を取れるため
  // V4 と重複する語句は省いている (dict バイトを節約)。
  const V5 = V4
    // 2-A 接続表現・敬語定型(長文連結フレーズ)
    + 'しかしながら、それにもかかわらず、というのも、いずれにしても、'
    + 'もちろん、おそらく、たぶん、おおむね、ほぼ、実際のところ、'
    + '基本的に、原則として、一般的に、すなわち、要するに、言い換えれば、'
    + '補足として、参考までに、ご注意ください、ご確認ください、'
    + 'よろしくお願いいたします、お願いいたします、お願い申し上げます、'
    + 'ありがとうございます、ありがとうございました、いただきますよう、'
    + '恐れ入りますが、お手数ですが、ご了承ください、ご容赦ください、'
    // 2-E プログラミング和訳(コード解説アーティファクトで頻出)
    + '実装、関数、変数、引数、戻り値、配列、オブジェクト、クラス、'
    + 'メソッド、プロパティ、条件分岐、繰り返し、例外処理、非同期、同期、'
    + 'コンパイル、デバッグ、リリース、デプロイ、ビルド、リポジトリ、'
    + 'ブランチ、コミット、マージ、プッシュ、プルリクエスト、'
    // 2-D アーティファクト/プレゼン/ドキュメント構造
    + 'おわりに、参考文献、付録、ステップ、手順、備考、ポイント、'
    + 'セクション、第1章、第2章、第3章、第1節、第2節、'
    // 2-H 数字 + 日本語(章番号・箇条書き定型)
    + '1つ目、2つ目、3つ目、(1)(2)(3)ステップ1ステップ2、'
    // 2-C ウェブフォーム定型(NotionAI 生成 HTML で頻出)
    + 'お名前、フリガナ、ローマ字、メールアドレス、電話番号、'
    + '郵便番号、住所、パスワード(確認)、必須、任意、半角英数、全角カナ、'
    + '新規登録、会員登録、利用規約、同意する、'
    // 2-F HTML × 日本語 閉じタグ(部分マッチで広く効く)
    + '>セクション</h2>>ステップ</h2>>手順</h2>>注意</strong>'
    + '>必須</span>>任意</span>>登録</button>>同意する</button>>戻る</a>'
    // 2-G 絵文字 × 日本語(Notion 文化圏で頻出。1マッチで 10〜13 バイト稼げる)
    + '✅完了、❌失敗、⚠️注意、💡ヒント、📝メモ、🔥重要、'
    + '📌ピン留め、🚀リリース、📊データ、🔧設定、'
    // 2-B カタカナ外来語(最頻出 → LZ ウィンドウ末尾に最も近く配置)
    + 'インターネット、コンピューター、ウェブサイト、データベース、'
    + 'ソフトウェア、アプリケーション、プログラミング、システム、サービス、'
    + 'ユーザー、メッセージ、ステータス、フォーマット、プロジェクト、'
    + 'マネジメント、スケジュール、カスタマー、コンテンツ、スタートアップ、'
    + 'フィードバック、ダウンロード、アップロード、インストール、アップデート、'
    + 'ログイン、ログアウト、プロフィール、アカウント、セキュリティ、'
    + 'プライバシーポリシー、カテゴリー、キーワード、ドキュメント、'
    + 'テンプレート、インターフェース、オプション、メニュー、'
    + 'フィルター、ソート、ページ、タブ、モード';

  // バージョン管理配列: index=バージョン番号。0=辞書なし。新辞書は末尾に append するだけ。
  // 既存 URL の互換性のため、配列内の既存要素は絶対に変更・削除しない。
  // Object.freeze で配列とオブジェクトを凍結し、ロード後の偶発的・悪意ある
  // 書き換え (拡張機能・別スクリプトの window.UAT_DICTS.CUSTOM_DICTS.push(…) 等) を防ぐ。
  // 文字列は元々イミュータブルのため個別凍結不要。Array.isArray や添字アクセス、
  // .length 取得は凍結後も正常動作するため、読み取り側コードの変更は不要。
  return Object.freeze({
    CUSTOM_DICTS: Object.freeze([null, V1, V2, V3, V4, V5]),
    CURRENT_DICT_VERSION: 5
  });
})();