// dynamic-dict.js — Content-dependent (per-document) dictionary for V6 compression.
//
// V6 builds a small custom dictionary from the input HTML itself by extracting
// frequently occurring n-grams (5..32 byte長), then prepends the dictionary
// to the input before LZ-family compression (Brotli / zstd / deflate-raw / gzip
// / LZMA / brotli-wasm). The decoder reads the dictionary length from a varint
// header in the URL payload, decompresses, and strips the V5 static dict + the
// dynamic dict prefixes to recover the original HTML.
//
// V6 URL format:
//   #6<letter>=<base64url>
//   where the base64url-decoded bytes are:
//     <varint dynDictLen> + <compressed( v5Dict + dynDict + body )>
//
// V1〜V5 (`#1b=` 〜 `#5b=`) は引き続き dicts.js の静的辞書のみを使用するパス。
// V6 は dicts.js の V5 辞書 + 本ファイルでビルドした動的辞書の二段構え。
//
// 後方互換性: V1〜V5 の URL は dicts.js だけで完結するため、dynamic-dict.js が
// ロードされなくても影響なし。dynamic-dict.js のロードに失敗した場合は V6 を
// 候補から除外し、V5 を最良として採用する。
//
// このファイルは新しい URL 生成にのみ影響する。既存 URL のデコード経路は
// (V6 自体が新規プレフィックスのため) 過去 URL を一切壊さない。
//
// === 設計の複数回見直しチェック済みポイント ===
// 1. サロゲートペア中央での n-gram 切り出し → UTF-8 エンコードで U+FFFD に化けるが
//    、JS 文字列 length (UTF-16 code unit) は roundtrip で保存されるため slice ずれは起きない。
// 2. 辞書が空になるケース (ユニークすぎる本体、短すぎる本体) は buildDictionary が
//    空文字列を返し、呼び出し側は V6 バリアントを生成せずにスキップする。
// 3. varint は LEB128 unsigned。動的辞書長 ≤ 1024 なので最大 2 バイトだが、将来拡張
//    のため 5 バイト (35 bit) までデコード可能。上限超えは明示エラー。
// 4. Object.freeze で API を凍結し、ロード後の改ざんを防ぐ (dicts.js と同じ作法)。
// 5. window.UAT_DYNAMIC_DICT の名前空間は window.UAT_DICTS と同じ UAT_ プレフィックスで
//    形を揃え、他スクリプトとの衝突を避けている。

window.UAT_DYNAMIC_DICT = (() => {
  // ---- パラメータ ----
  // n-gram 長: LZ77 break-even (~3 bytes) より長く、deflate 32KB / Brotli 8MB 窓に収まる範囲。
  // 各長さで text を一周するため計算量は O(text.length × N_LENGTHS.length)。
  // 等差数列ではなく "短いほど密、長いほど疎" な間隔で並べることで、
  // 短い高頻度パターン (CSS class 名等) と長い反復ブロック (テンプレート JS 等) の
  // 両方を捕まえる。
  const N_LENGTHS = Object.freeze([5, 6, 8, 10, 12, 16, 20, 24, 32]);

  // 各 n に対する候補上限。長い n-gram ほど候補が少ないため、一律 K で十分。
  // K=500 は 50KB HTML × 9 length × 各 entry の overhead でメモリ上限 ~5MB 、
  // sort も 9×500=4500 件ソートで 1ms 以下。
  const TOP_K_PER_LEN = 500;

  // 入力本体の上限。これを超えると extractNgrams の Map メモリが OOM 圏に近づく
  // (1MB 入力 × 9 長 × ~50B/エントリ ≈ 450MB)。ここで弾いて V6 を完全スキップし、
  // V0/V5/V7 等の他バリアントは継続させる。500 KB の HTML を URL 短縮することは
  // 事実上ないため運用上の影響はない。sdht.js と同じ閾値で揃える。
  const MAX_INPUT_SIZE = 500 * 1024;

  // 本体サイズに応じた辞書バイト予算 (UTF-16 code unit 単位の長さ上限)。
  // 小さい本体に大きい辞書を付けると varint + 圧縮されない辞書バイトが
  // savings を食い潰すため、ここで段階的に絞る。閾値はベンチマーク前の経験値で、
  // 後でデバッグモード等で調整可能。
  const chooseBudget = (bodyLen) => {
    if (typeof bodyLen !== 'number' || bodyLen <= 0) return 0;
    if (bodyLen < 1024) return 0;       // 1KB 未満: 辞書なし
    if (bodyLen < 5120) return 128;     // 1..5KB: 128 B
    if (bodyLen < 15360) return 256;    // 5..15KB: 256 B
    if (bodyLen < 51200) return 512;    // 15..50KB: 512 B
    return 1024;                         // 50KB+: 1024 B
  };

  // ---- n-gram 抽出 ----
  // 各長さで全 n-gram の頻度を数え、freq>=2 の上位 K 件を候補配列に追加する。
  // length は UTF-16 code unit 単位。本体は TextEncoder で UTF-8 化されてから圧縮されるが、
  // JS string 連結 + slice での取り出し/復元は code unit 単位で行われるため、ここでも
  // code unit 単位を使うのが整合的。
  // サロゲートペア中央でスライスされると UTF-8 化時に U+FFFD に化けて辞書が
  // 無駄になるが、稀なため許容 (圧縮率がわずかに下がるだけで誤動作しない)。
  // String#substr はレガシーなため slice(i, i+n) を使用。
  const extractNgrams = (text, n) => {
    const map = new Map();
    const lim = text.length - n;
    if (lim < 0) return map;
    for (let i = 0; i <= lim; i++) {
      const ng = text.slice(i, i + n);
      const f = map.get(ng);
      map.set(ng, f === undefined ? 1 : f + 1);
    }
    return map;
  };

  // ---- 辞書構築 ----
  // 1. 各 n に対して n-gram 頻度マップを作成 → freq>=2 を残し → 頻度上位 K 件を抽出
  // 2. 全候補を score = (freq-1) × max(0, len-3) で評価し降順ソート
  //    - freq-1: 辞書側に書く 1 回分は節約にならない (LZ77 後方参照は 2 回目以降から効く)
  //    - len-3:  deflate の break-even ≈ 3 bytes (これ以下は元符号化と同じか劣る)
  // 3. 貪欲選択: budget 内で「既存辞書の部分文字列でない」候補を順次追加
  //    部分文字列重複を弾くことで、長いマッチが既に辞書に居るのに短い prefix も
  //    辞書に入れるような無駄を防ぐ。indexOf は O(dict.length) なので最大 1024B
  //    辞書 × ~3000 候補 = 3M 文字検索 → 数十ms 以内。
  const buildDictionary = (text, budget) => {
    if (!text || typeof text !== 'string') return '';
    // 巨大入力では n-gram Map が OOM 圏に近づくため早期リターン。V6 のみスキップし
    // V0/V5/V7 等の他バリアントは継続 (sdht.js と同一の保険動作)。
    if (text.length > MAX_INPUT_SIZE) return '';
    if (typeof budget !== 'number' || budget <= 0) return '';
    if (text.length < N_LENGTHS[0]) return '';

    const candidates = [];
    for (let li = 0; li < N_LENGTHS.length; li++) {
      const n = N_LENGTHS[li];
      if (text.length < n) continue;
      const map = extractNgrams(text, n);
      // freq>=2 のみ抽出
      const arr = [];
      map.forEach((f, ng) => { if (f >= 2) arr.push({ ng: ng, f: f, n: n }); });
      // 頻度降順 → 上位 K
      arr.sort((a, b) => b.f - a.f);
      const cap = Math.min(arr.length, TOP_K_PER_LEN);
      for (let i = 0; i < cap; i++) {
        const c = arr[i];
        const score = (c.f - 1) * (c.n - 3);
        if (score <= 0) continue;
        candidates.push({ ng: c.ng, score: score, n: c.n });
      }
      // map は loop 抜けで GC 対象
    }
    if (candidates.length === 0) return '';

    // 全長一括ソート: score 降順 → 同点なら長さ降順 (長いマッチほど LZ77 の効率が良い)
    candidates.sort((a, b) => (b.score - a.score) || (b.n - a.n));

    // 貪欲選択
    let dict = '';
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (dict.length + c.n > budget) continue;
      // 既選択辞書の部分文字列はスキップ (重複登録の防止)
      if (dict.indexOf(c.ng) >= 0) continue;
      dict += c.ng;
      if (dict.length >= budget) break;
    }
    return dict;
  };

  // ---- varint (LEB128 unsigned, little-endian) ----
  // 0..127       → 1 byte
  // 128..16383   → 2 bytes
  // 16384..〜    → 3 bytes
  // 動的辞書長は最大 1024 のため最大 2 bytes で足りるが、将来拡張のため 5 byte まで対応。
  // ビット演算 (>>>) は 32-bit 上限なのでそれ以上は除算で扱う (運用範囲では発火しない)。
  const varintEncode = (n) => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new Error('varintEncode: non-negative integer required, got ' + n);
    }
    const bytes = [];
    let v = n;
    // 最大 5 バイト (35-bit まで)。これを超える値は明示エラーとする。
    for (let i = 0; i < 5; i++) {
      if (v < 0x80) { bytes.push(v); return new Uint8Array(bytes); }
      bytes.push((v & 0x7F) | 0x80);
      v = Math.floor(v / 128);
    }
    throw new Error('varintEncode: value too large: ' + n);
  };

  // bytes: Uint8Array または添字アクセス可能なバイト配列。offset: 読み出し開始位置。
  // 戻り値 { value: number, nextOffset: number }。途中でバッファ末尾に達したり、
  // 5 バイトを超えたりしたら明示エラーとして throw。
  const varintDecode = (bytes, offset) => {
    if (!bytes || typeof bytes.length !== 'number') {
      throw new Error('varintDecode: bytes array required');
    }
    let off = (offset | 0);
    if (off < 0) off = 0;
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 5; i++) {
      if (off >= bytes.length) throw new Error('varintDecode: truncated at offset ' + off);
      const b = bytes[off++];
      value += (b & 0x7F) * multiplier;
      if ((b & 0x80) === 0) return { value: value, nextOffset: off };
      multiplier *= 128;
    }
    throw new Error('varintDecode: too long (>5 bytes)');
  };

  // 公開 API。Object.freeze で改ざんを防ぐ (関数本体は元々 immutable)。
  return Object.freeze({
    buildDictionary: buildDictionary,
    chooseBudget: chooseBudget,
    varintEncode: varintEncode,
    varintDecode: varintDecode,
    N_LENGTHS: N_LENGTHS,
    TOP_K_PER_LEN: TOP_K_PER_LEN
  });
})();