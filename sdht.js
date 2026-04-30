/**
 * V7 SDHT (Stack-based Document HTML Transform / Shortcut Dictionary Token)
 *
 * 本体内トークン置換による HTML 圧縮の前処理。
 * V6 が LZ 圧縮の辞書プレフィックスとして外部辞書を提供するのに対し、
 * V7 は本体を物理的に短縮してから圧縮器に渡す。両者は補完関係。
 *
 * トークン形式:
 *   ESC = 0x1D (Group Separator, ASCII 制御文字、UTF-8 単独出現で安全、A-3 の 0x01-0x1C と非衝突)
 *   ESC + 0x00..0xFD = テーブルインデックス (最大 254 エントリ)
 *   ESC + 0xFE = リテラル 0x1D エスケープ (元 HTML 内の 0x1D を保護)
 *   ESC + 0xFF = 予約
 *
 * ペイロード形式:
 *   varint(N) + N × (varint(len) + len UTF-16 units) + transformedBody
 *
 * スコア式:
 *   freq × (len - 2) - (len + 1)
 *   = 純 UTF-16 unit 削減量 (テーブルエントリオーバーヘッド = len + 1 バイト、各置換で len - 2 バイト削減)
 *   損益分岐: freq × (len-2) > (len+1) を満たす (len, freq) ペア。
 *     主な例: (5, 3+) / (6, 2+) / (8, 2+) / (16, 2+) はプラス、(5, 2) は score = 0 で取らない。
 *
 * 後方互換: V1〜V6 は完全不変、V7 は新プレフィックス #7b= / #7B= の追加のみ
 */
;(function () {
	'use strict';

	const ESC_CODE = 0x1D;
	const LITERAL_ESC_BYTE = 0xFE;
	const RESERVED_BYTE = 0xFF;
	const MAX_TOKENS = 254;
	const N_LENGTHS = Object.freeze([5, 6, 8, 10, 12, 16, 20, 24, 32]);
	const MIN_FREQ = 2;
	// 各 n-gram 長で頻度上位何件まで候補に残すか。これがないと巨大入力で Map サイズと
	// 貪欲選択ループ O(K × 選択済) の計算量が爆発する (50KB 入力で len=5 なら ~50K 件の
	// Map × 9 長 = 450K 候補 → 貪欲 254 選択で最悪 100M オーダーの文字列比較)。
	// 500 件で 9 長計 4500 候補に抑えれば、貪欲ループは 最悪 1M 比較で 100ms 未満に収まる。
	const TOP_K_PER_LEN = 500;
	// 入力本体の上限。これを超えると extractCandidates の Map メモリが OOM 圏に近づく
	// (1MB 入力 × 9 長 × ~50B/エントリ ≈ 450MB)。ここで弾いて V7 を完全スキップする。
	// 500 KB の HTML を URL 短縮することは事実上ないため運用上の影響はない。
	const MAX_INPUT_SIZE = 500 * 1024;
	// escape 後のサイズが入力の ESCAPE_BLOWUP_LIMIT 倍を超える入力はバイナリ等の異常値と見なし
	// V7 をスキップする (正常 HTML は 0x1D を含まないため escape 後サイズ = 入力サイズ)。
	const ESCAPE_BLOWUP_LIMIT = 1.5;
	const ESC = String.fromCharCode(ESC_CODE);
	const LITERAL_ESC = ESC + String.fromCharCode(LITERAL_ESC_BYTE);

	/**
	 * 本体長に応じて最大トークン数を選択。
	 * 小さいファイルではテーブルオーバーヘッドが利得を上回るため辞書なし。
	 */
	function chooseBudget(len) {
		if (len < 1024) return 0;
		if (len < 5 * 1024) return 32;
		if (len < 15 * 1024) return 64;
		if (len < 50 * 1024) return 128;
		return MAX_TOKENS;
	}

	/** LEB128 unsigned varint エンコード (最大 5 バイト = 35-bit) */
	function varintEncode(n) {
		if (typeof n !== 'number' || n < 0 || !Number.isFinite(n) || n > 0x7FFFFFFFF) {
			throw new Error('[ERROR] SDHT varint overflow: ' + n);
		}
		let s = '';
		do {
			let b = n & 0x7F;
			n = Math.floor(n / 128);
			if (n > 0) b |= 0x80;
			s += String.fromCharCode(b);
		} while (n > 0);
		return s;
	}

	/** LEB128 unsigned varint デコード。{value, next} を返す */
	function varintDecode(s, pos) {
		let n = 0;
		let shift = 0;
		for (let i = 0; i < 5; i++) {
			if (pos + i >= s.length) {
				throw new Error('[ERROR] SDHT varint truncated at ' + (pos + i));
			}
			const b = s.charCodeAt(pos + i);
			n += (b & 0x7F) * Math.pow(2, shift);
			shift += 7;
			if ((b & 0x80) === 0) return { value: n, next: pos + i + 1 };
		}
		throw new Error('[ERROR] SDHT varint exceeds 5 bytes');
	}

	/** 元 HTML 内のリテラル 0x1D を保護するためエスケープ */
	function escapeLiteralEsc(text) {
		if (text.indexOf(ESC) < 0) return text;
		return text.split(ESC).join(LITERAL_ESC);
	}

	/** 不対サロゲート (UTF-8 化で U+FFFD に化ける) を含む n-gram を弾くチェック */
	function hasUnpairedSurrogate(s) {
		for (let i = 0; i < s.length; i++) {
			const c = s.charCodeAt(i);
			if (c >= 0xD800 && c <= 0xDBFF) {
				if (i + 1 >= s.length) return true;
				const c2 = s.charCodeAt(i + 1);
				if (c2 < 0xDC00 || c2 > 0xDFFF) return true;
				i++;
			} else if (c >= 0xDC00 && c <= 0xDFFF) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 反復 n-gram を抽出してスコアでソート。
	 * 各長さで頻度上位 TOP_K_PER_LEN 件のみ候補に残し、メモリと貪欲選択の計算量を抑える。
	 */
	function extractCandidates(text, lengths) {
		const cands = [];
		for (let li = 0; li < lengths.length; li++) {
			const len = lengths[li];
			const limit = text.length - len;
			if (limit < 0) continue; // text が len 未満のときはスキップ (疑似スキャンを走らせない)
			const counts = new Map();
			for (let i = 0; i <= limit; i++) {
				const ng = text.slice(i, i + len);
				if (ng.indexOf(ESC) >= 0) continue;
				if (hasUnpairedSurrogate(ng)) continue;
				counts.set(ng, (counts.get(ng) || 0) + 1);
			}
			// freq >= MIN_FREQ のみ抽出 → 頻度降順で上位 TOP_K_PER_LEN 件 → スコア計算
			const arr = [];
			counts.forEach(function (freq, ng) {
				if (freq >= MIN_FREQ) arr.push({ ng: ng, freq: freq });
			});
			arr.sort(function (a, b) { return b.freq - a.freq; });
			const cap = Math.min(arr.length, TOP_K_PER_LEN);
			for (let i = 0; i < cap; i++) {
				const score = arr[i].freq * (len - 2) - (len + 1);
				if (score <= 0) continue;
				cands.push({ ng: arr[i].ng, freq: arr[i].freq, len: len, score: score });
			}
		}
		cands.sort(function (a, b) { return b.score - a.score || b.len - a.len; });
		return cands;
	}

	/**
	 * SDHT エンコード。利得が見込めない場合は null を返す (試行は trial loop で再度判定)。
	 * @param {string} text - HTML 本体 (ミニファイ済み推奨)
	 * @returns {string|null} ペイロード文字列 (varint(N) + entries + body)
	 */
	function encode(text) {
		if (typeof text !== 'string' || text.length === 0) return null;
		// 巨大入力では n-gram Map が OOM 圏に近づくため早期リターン。実運用で 500KB を
		// 超える HTML を URL 短縮することはまずないが、ペーストミス等で混入したときに
		// V7 だけブラウザを固まらせないよう保険として弾く。
		if (text.length > MAX_INPUT_SIZE) return null;
		const escaped = escapeLiteralEsc(text);
		// エスケープ後にサイズが膨張しすぎる入力 (リテラル 0x1D が大量に含まれるバイナリ等)
		// も同様に弾く。正常な HTML は 0x1D をほぼ含まないため escape 後サイズは入力と同じになる。
		// 1.5 倍以上膨張した場合は入力自体が異常 (バイナリダンプ等) と判断し V7 をスキップ。
		if (escaped.length > text.length * ESCAPE_BLOWUP_LIMIT) return null;
		const budget = chooseBudget(escaped.length);
		if (budget === 0) return null;

		const cands = extractCandidates(escaped, N_LENGTHS);
		if (cands.length === 0) return null;

		// 貪欲選択: 既選択トークンと相互含有する候補は除外
		const selected = [];
		const selectedSet = [];
		for (let i = 0; i < cands.length && selected.length < budget; i++) {
			const ng = cands[i].ng;
			let skip = false;
			for (let j = 0; j < selectedSet.length; j++) {
				if (selectedSet[j].indexOf(ng) >= 0 || ng.indexOf(selectedSet[j]) >= 0) {
					skip = true;
					break;
				}
			}
			if (!skip) {
				selected.push(cands[i]);
				selectedSet.push(ng);
			}
		}
		if (selected.length === 0) return null;

		// 長さ降順で置換 (短いトークンが長いトークンの一部を先に潰すのを防ぐ)
		selected.sort(function (a, b) { return b.len - a.len; });

		// 実際に置換できたエントリのみテーブルに登録 (インデックス連番を保証)
		let body = escaped;
		const table = [];
		for (let i = 0; i < selected.length; i++) {
			const c = selected[i];
			const idx = table.length;
			if (idx > 0xFD) break;
			const tok = ESC + String.fromCharCode(idx);
			const replaced = body.split(c.ng).join(tok);
			if (replaced.length < body.length) {
				body = replaced;
				table.push(c.ng);
			}
		}
		if (table.length === 0) return null;

		// シリアライズ
		let out = varintEncode(table.length);
		for (let i = 0; i < table.length; i++) {
			out += varintEncode(table[i].length);
			out += table[i];
		}
		out += body;
		return out;
	}

	/**
	 * SDHT デコード。元の文字列を復元。不正な入力は throw。
	 * @param {string} payload - encode の出力
	 * @returns {string}
	 */
	function decode(payload) {
		if (typeof payload !== 'string') {
			throw new Error('[ERROR] SDHT decode: expected string');
		}
		let pos = 0;
		const headerN = varintDecode(payload, pos);
		pos = headerN.next;
		const N = headerN.value;
		if (N > MAX_TOKENS) {
			throw new Error('[ERROR] SDHT table size exceeds max: ' + N);
		}
		const table = new Array(N);
		for (let i = 0; i < N; i++) {
			const lenInfo = varintDecode(payload, pos);
			pos = lenInfo.next;
			const len = lenInfo.value;
			if (pos + len > payload.length) {
				throw new Error('[ERROR] SDHT entry ' + i + ' truncated (need ' + len + ', have ' + (payload.length - pos) + ')');
			}
			table[i] = payload.slice(pos, pos + len);
			pos += len;
		}
		const body = payload.slice(pos);

		// トークン展開 (リテラル 0x1D は ESC+0xFE で復元)
		let out = '';
		let i = 0;
		const bodyLen = body.length;
		while (i < bodyLen) {
			const ch = body.charCodeAt(i);
			if (ch === ESC_CODE) {
				if (i + 1 >= bodyLen) {
					throw new Error('[ERROR] SDHT body truncated at ESC pos ' + i);
				}
				const nb = body.charCodeAt(i + 1);
				if (nb === LITERAL_ESC_BYTE) {
					out += ESC;
					i += 2;
				} else if (nb === RESERVED_BYTE) {
					throw new Error('[ERROR] SDHT reserved byte 0xFF at pos ' + i);
				} else if (nb < N) {
					out += table[nb];
					i += 2;
				} else {
					throw new Error('[ERROR] SDHT token index ' + nb + ' out of range (N=' + N + ') at pos ' + i);
				}
			} else {
				out += body.charAt(i);
				i++;
			}
		}
		return out;
	}

	if (typeof window !== 'undefined') {
		window.UAT_SDHT = Object.freeze({
			encode: encode,
			decode: decode,
			chooseBudget: chooseBudget,
			varintEncode: varintEncode,
			varintDecode: varintDecode,
			ESC_CODE: ESC_CODE,
			MAX_TOKENS: MAX_TOKENS,
			N_LENGTHS: N_LENGTHS,
		});
	}
})();