// ==UserScript==
// @name         番茄小说网页阅读增强
// @namespace    https://github.com/xyz18950377305
// @version      0.2.0
// @updateURL    https://raw.githubusercontent.com/xyz18950377305/fanqie-web-free-reader/main/fanqie-web-free-reader.user.js
// @downloadURL  https://raw.githubusercontent.com/xyz18950377305/fanqie-web-free-reader/main/fanqie-web-free-reader.user.js
// @description  在番茄小说网页版直接阅读完整正文，无需安装客户端
// @author       小宇
// @license      MIT
// @icon         https://p1-tt.byteimg.com/origin/novel-static/a3621391ca2e537045168afda6722ee9
// @match        https://fanqienovel.com/reader/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/**
 * 番茄小说网页阅读增强
 *
 * 功能
 * ----
 * 在番茄小说网页版直接阅读完整正文，无需安装客户端，无需登录账号。
 * 网页端默认仅放出部分章节，其余章节由「扫码下载 APP」浮层遮挡；本脚本将这部分正文补齐并移除遮挡层。
 *
 * 实现原理
 * --------
 *
 * 本脚本以番茄 Android 客户端身份请求其正文接口获取明文，流程如下：
 *   1. 从 URL 提取章节 ID（/reader/<itemId>）
 *   2. 首次运行注册匿名设备，取得 device_id 与正文解密密钥并缓存
 *   3. 携带请求签名调用正文接口，取得 base64 密文
 *   4. 以设备密钥执行 AES-128-CBC 解密，按需解压 gzip
 *   5. 将明文渲染至页面，并隐藏付费遮挡层
 *
 * 签名与设备注册算法移植自 fqapp 的 Rust 实现。
 *
 * 正文接口
 * --------
 * 客户端提供两个正文接口。
 *
 *   full
 *     https://reading.snssdk.com/reading/reader/full/v/
 *     单章接口，参数 item_id。正文位于 data.content，标题位于 data.title。
 *     默认使用此接口。
 *
 *   batch_full
 *     https://api5-normal-sinfonlineb.fqnovel.com/reading/reader/batch_full/v
 *     批量接口，参数 item_ids（逗号分隔）。响应为
 *     { itemId: { content, title, novel_data, ... } } 形式。
 *     需额外携带 book_id=0 与 req_type=1。
 *
 * 两者共用同一匿名设备身份与同一套签名头（x-argus / x-ladon / x-khronos / x-ss-req-ticket）。
 *
 * 预加载
 * ------
 * 面板提供「提前加载下一章」开关（默认关闭）。开启后渲染完当前章节即取回下一
 * 章并缓存，切章直接命中缓存，并接力预取再下一章。
 *
 * 下一章 ID 取自响应的 novel_data.next_item_id，两个接口都提供，无需查目录。
 * 缓存保留最近 3 章；切换接口、关闭开关、__fanqieReset() 都会清空。
 *
 * 接口可通过页面右下角的下拉框切换，切换后当前章节立即重新加载；任一接口失败时自动回退至另一接口。
 *
 * 单页应用适配
 * ------------
 * 番茄阅读器为单页应用，目录跳转与上一页/下一页均不触发页面重载，故采用 MutationObserver 配合 URL 轮询检测章节切换。
 *
 * 调试
 * ----
 * 油猴菜单提供「清除设备缓存（重新注册）」，等价于控制台执行 __fanqieReset()。
 * __fanqieReset()            清除设备缓存，下次运行重新注册
 * __fanqieApi('full'|'batch') 切换正文接口
 * __fanqiePrefetch(true|false) 开关提前加载下一章
 */
(function () {
  'use strict';

  // ===== 编码工具 =====
  // 字节、十六进制与 base64 互转。签名链路全程按字节运算，不经过字符串。

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    let out = '';
    for (const b of bytes) out += (b >> 4).toString(16) + (b & 15).toString(16);
    return out;
  }

  function bytesToHexUpper(bytes) {
    return bytesToHex(bytes).toUpperCase();
  }

  function concatBytes(...arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      out.set(a, offset);
      offset += a.length;
    }
    return out;
  }

  function randomBytes(n) {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  }

  function bytesToBase64(bytes) {
    let out = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) {
      const n = bytes[i] << 16;
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
    } else if (rest === 2) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
    }
    return out;
  }

  function base64ToBytes(text) {
    const clean = String(text).replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array((clean.length * 3) >> 2);
    let acc = 0;
    let bits = 0;
    let index = 0;
    for (const ch of clean) {
      const value = B64.indexOf(ch);
      if (value < 0) continue;
      acc = (acc << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[index++] = (acc >> bits) & 0xff;
      }
    }
    return out.subarray(0, index);
  }

  const utf8Bytes = (text) => new TextEncoder().encode(text);
  const utf8Decode = (bytes) => new TextDecoder('utf-8').decode(bytes);

  // ===== MD5 =====
  // 供 x-ss-stub 使用：对请求体取摘要，作为签名输入之一。

  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const MD5_K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

  function md5(input) {
    const data = typeof input === 'string' ? utf8Bytes(input) : input;
    const bitLen = data.length * 8;
    const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
    padded.set(data);
    padded[data.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, bitLen >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const m = new Uint32Array(16);

    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i = 0; i < 16; i++) m[i] = view.getUint32(offset + i * 4, true);
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        f = (f + a + MD5_K[i] + m[g]) >>> 0;
        a = d; d = c; c = b;
        b = (b + ((f << MD5_S[i]) | (f >>> (32 - MD5_S[i])))) >>> 0;
      }
      a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    }

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, a0, true);
    outView.setUint32(4, b0, true);
    outView.setUint32(8, c0, true);
    outView.setUint32(12, d0, true);
    return out;
  }

  const md5Hex = (bytes) => bytesToHex(md5(bytes));

  // ===== SHA-512 =====
  // 供设备注册的 tt_encrypt 使用：由随机数与固定串派生 AES 密钥和 IV。

  const MASK64 = 0xffffffffffffffffn;
  const rotr64n = (x, n) => ((x >> n) | (x << (64n - n))) & MASK64;
  const shr64n = (x, n) => x >> n;

  const SHA512_K = [
    '428a2f98d728ae22','7137449123ef65cd','b5c0fbcfec4d3b2f','e9b5dba58189dbbc',
    '3956c25bf348b538','59f111f1b605d019','923f82a4af194f9b','ab1c5ed5da6d8118',
    'd807aa98a3030242','12835b0145706fbe','243185be4ee4b28c','550c7dc3d5ffb4e2',
    '72be5d74f27b896f','80deb1fe3b1696b1','9bdc06a725c71235','c19bf174cf692694',
    'e49b69c19ef14ad2','efbe4786384f25e3','0fc19dc68b8cd5b5','240ca1cc77ac9c65',
    '2de92c6f592b0275','4a7484aa6ea6e483','5cb0a9dcbd41fbd4','76f988da831153b5',
    '983e5152ee66dfab','a831c66d2db43210','b00327c898fb213f','bf597fc7beef0ee4',
    'c6e00bf33da88fc2','d5a79147930aa725','06ca6351e003826f','142929670a0e6e70',
    '27b70a8546d22ffc','2e1b21385c26c926','4d2c6dfc5ac42aed','53380d139d95b3df',
    '650a73548baf63de','766a0abb3c77b2a8','81c2c92e47edaee6','92722c851482353b',
    'a2bfe8a14cf10364','a81a664bbc423001','c24b8b70d0f89791','c76c51a30654be30',
    'd192e819d6ef5218','d69906245565a910','f40e35855771202a','106aa07032bbd1b8',
    '19a4c116b8d2d0c8','1e376c085141ab53','2748774cdf8eeb99','34b0bcb5e19b48a8',
    '391c0cb3c5c95a63','4ed8aa4ae3418acb','5b9cca4f7763e373','682e6ff3d6b2b8a3',
    '748f82ee5defb2fc','78a5636f43172f60','84c87814a1f0ab72','8cc702081a6439ec',
    '90befffa23631e28','a4506cebde82bde9','bef9a3f7b2c67915','c67178f2e372532b',
    'ca273eceea26619c','d186b8c721c0c207','eada7dd6cde0eb1e','f57d4f7fee6ed178',
    '06f067aa72176fba','0a637dc5a2c898a6','113f9804bef90dae','1b710b35131c471b',
    '28db77f523047d84','32caab7b40c72493','3c9ebe0a15c9bebc','431d67c49c100d4c',
    '4cc5d4becb3e42b6','597f299cfc657e2a','5fcb6fab3ad6faec','6c44198c4a475817',
  ].map((h) => BigInt('0x' + h));

  const SHA512_IV = [
    '6a09e667f3bcc908','bb67ae8584caa73b','3c6ef372fe94f82b','a54ff53a5f1d36f1',
    '510e527fade682d1','9b05688c2b3e6c1f','1f83d9abfb41bd6b','5be0cd19137e2179',
  ].map((h) => BigInt('0x' + h));

  function sha512(input) {
    const data = typeof input === 'string' ? utf8Bytes(input) : input;
    const bitLen = BigInt(data.length) * 8n;
    const padded = new Uint8Array((((data.length + 16) >> 7) + 1) << 7);
    padded.set(data);
    padded[data.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setBigUint64(padded.length - 16, bitLen >> 64n, false);
    view.setBigUint64(padded.length - 8, bitLen & MASK64, false);

    let [h0, h1, h2, h3, h4, h5, h6, h7] = SHA512_IV;
    const w = new Array(80);

    for (let offset = 0; offset < padded.length; offset += 128) {
      for (let i = 0; i < 16; i++) w[i] = view.getBigUint64(offset + i * 8, false);
      for (let i = 16; i < 80; i++) {
        const s0 = rotr64n(w[i - 15], 1n) ^ rotr64n(w[i - 15], 8n) ^ shr64n(w[i - 15], 7n);
        const s1 = rotr64n(w[i - 2], 19n) ^ rotr64n(w[i - 2], 61n) ^ shr64n(w[i - 2], 6n);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
      }
      let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
      for (let i = 0; i < 80; i++) {
        const S1 = rotr64n(e, 14n) ^ rotr64n(e, 18n) ^ rotr64n(e, 41n);
        const ch = (e & f) ^ (~e & MASK64 & g);
        const temp1 = (h + S1 + ch + SHA512_K[i] + w[i]) & MASK64;
        const S0 = rotr64n(a, 28n) ^ rotr64n(a, 34n) ^ rotr64n(a, 39n);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) & MASK64;
        h = g; g = f; f = e; e = (d + temp1) & MASK64;
        d = c; c = b; b = a; a = (temp1 + temp2) & MASK64;
      }
      h0 = (h0 + a) & MASK64; h1 = (h1 + b) & MASK64;
      h2 = (h2 + c) & MASK64; h3 = (h3 + d) & MASK64;
      h4 = (h4 + e) & MASK64; h5 = (h5 + f) & MASK64;
      h6 = (h6 + g) & MASK64; h7 = (h7 + h) & MASK64;
    }

    const out = new Uint8Array(64);
    const outView = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => outView.setBigUint64(i * 8, v, false));
    return out;
  }

  // ===== SM3 =====
  // 国密哈希算法，x-argus 用它计算 query 与 body 的摘要。

  const SM3_IV = [0x7380166f,0x4914b2b9,0x172442d7,0xda8a0600,0xa96f30bc,0x163138aa,0xe38dee4d,0xb0fb0e4e];
  const rotl32 = (v, s) => { s %= 32; return s === 0 ? v >>> 0 : ((v << s) | (v >>> (32 - s))) >>> 0; };
  const sm3P0 = (x) => (x ^ rotl32(x, 9) ^ rotl32(x, 17)) >>> 0;
  const sm3P1 = (x) => (x ^ rotl32(x, 15) ^ rotl32(x, 23)) >>> 0;

  function sm3Compress(v, block, offset) {
    const w = new Uint32Array(68);
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = ((block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3]) >>> 0;
    }
    for (let j = 16; j < 68; j++) {
      w[j] = (sm3P1((w[j - 16] ^ w[j - 9] ^ rotl32(w[j - 3], 15)) >>> 0) ^ rotl32(w[j - 13], 7) ^ w[j - 6]) >>> 0;
    }
    const w1 = new Uint32Array(64);
    for (let j = 0; j < 64; j++) w1[j] = (w[j] ^ w[j + 4]) >>> 0;

    let [a, b, c, d, e, f, g, h] = v;
    for (let j = 0; j < 64; j++) {
      const tj = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const ss1 = rotl32((rotl32(a, 12) + e + rotl32(tj, j)) >>> 0, 7);
      const ss2 = (ss1 ^ rotl32(a, 12)) >>> 0;
      const ff = j < 16 ? (a ^ b ^ c) >>> 0 : ((a & b) | (a & c) | (b & c)) >>> 0;
      const gg = j < 16 ? (e ^ f ^ g) >>> 0 : ((e & f) | (~e & g)) >>> 0;
      const tt1 = (ff + d + ss2 + w1[j]) >>> 0;
      const tt2 = (gg + h + ss1 + w[j]) >>> 0;
      d = c; c = rotl32(b, 9); b = a; a = tt1;
      h = g; g = rotl32(f, 19); f = e; e = sm3P0(tt2);
    }
    return [
      (a ^ v[0]) >>> 0, (b ^ v[1]) >>> 0, (c ^ v[2]) >>> 0, (d ^ v[3]) >>> 0,
      (e ^ v[4]) >>> 0, (f ^ v[5]) >>> 0, (g ^ v[6]) >>> 0, (h ^ v[7]) >>> 0,
    ];
  }

  function sm3Hash(message) {
    const data = typeof message === 'string' ? utf8Bytes(message) : message;
    const origLen = data.length;
    const reserve = (origLen % 64) + 1;
    let rangeEnd = 56;
    if (rangeEnd < reserve) rangeEnd += 64;
    const padded = new Uint8Array(origLen + 1 + (rangeEnd - reserve) + 8);
    padded.set(data);
    padded[origLen] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor((origLen * 8) / 0x100000000), false);
    view.setUint32(padded.length - 4, (origLen * 8) >>> 0, false);

    let v = SM3_IV.slice();
    for (let i = 0; i < padded.length; i += 64) v = sm3Compress(v, padded, i);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, v[i], false);
    return out;
  }

  // ===== Simon =====
  // 轻量分组密码，x-argus 用它加密 protobuf bean。

  const SIMON_Z = 0x3dc94c3a046d678bn;
  const rotl64 = (v, n) => { const s = BigInt(n); return ((v << s) | (v >> (64n - s))) & MASK64; };
  const rotr64 = (v, n) => { const s = BigInt(n); return ((v >> s) | (v << (64n - s))) & MASK64; };

  function simonKeyExpansion(key) {
    const out = key.slice();
    for (let i = 4; i < 72; i++) {
      let tmp = rotr64(out[i - 1], 3);
      tmp ^= out[i - 3];
      tmp ^= rotr64(tmp, 1);
      const notVal = ~out[i - 4] & MASK64;
      const bitVal = (SIMON_Z >> BigInt((i - 4) % 62)) & 1n;
      out[i] = (notVal ^ tmp ^ bitVal ^ 3n) & MASK64;
    }
    return out;
  }

  function simonEncrypt(pt0, pt1, keyWords) {
    const key = simonKeyExpansion(keyWords);
    let xi = pt0, xi1 = pt1;
    for (let i = 0; i < 72; i++) {
      const tmp = xi1;
      const f = rotl64(xi1, 1) & rotl64(xi1, 8);
      xi1 = (xi ^ f ^ rotl64(xi1, 2) ^ key[i]) & MASK64;
      xi = tmp;
    }
    return [xi, xi1];
  }

  const readU64LE = (bytes, offset) => {
    let value = 0n;
    for (let i = 0; i < 8; i++) value |= BigInt(bytes[offset + i]) << BigInt(i * 8);
    return value;
  };

  const writeU64LE = (bytes, offset, value) => {
    for (let i = 0; i < 8; i++) bytes[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  };

  // ===== AES =====
  // 用于两处：x-argus 外层加密与正文解密。此处为纯 JS 实现，因为签名链路
  // 要求同步返回，无法使用 WebCrypto 的异步接口。

  const SBOX = new Uint8Array(256);
  const INV_SBOX = new Uint8Array(256);
  (function buildSbox() {
    const rotl8 = (x, s) => ((x << s) | (x >> (8 - s))) & 0xff;
    let p = 1, q = 1;
    do {
      p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
      q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
      if (q & 0x80) q ^= 0x09;
      const x = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4);
      SBOX[p] = (x ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  })();

  const xtime = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

  function gmul(a, b) {
    let result = 0, x = a, y = b;
    while (y) {
      if (y & 1) result ^= x;
      x = xtime(x);
      y >>= 1;
    }
    return result & 0xff;
  }

  /**
   * AES 密钥扩展，支持 128 位（10 轮）和 256 位（14 轮）。
   * full/mget 接口用 AES-256，其余地方用 AES-128。
   */
  function aesExpandKey(key) {
    const nk = key.length / 4;            // 4 或 8
    const rounds = nk + 6;                // 10 或 14
    const total = (rounds + 1) * 16;
    const roundKeys = new Uint8Array(total);
    roundKeys.set(key);
    let rcon = 1;
    for (let i = key.length; i < total; i += 4) {
      let t0 = roundKeys[i - 4], t1 = roundKeys[i - 3], t2 = roundKeys[i - 2], t3 = roundKeys[i - 1];
      if (i % key.length === 0) {
        const tmp = t0;
        t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[tmp];
        rcon = xtime(rcon);
      } else if (nk > 6 && i % key.length === 16) {
        // AES-256 额外做一次 SubWord
        t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3];
      }
      roundKeys[i] = roundKeys[i - key.length] ^ t0;
      roundKeys[i + 1] = roundKeys[i - key.length + 1] ^ t1;
      roundKeys[i + 2] = roundKeys[i - key.length + 2] ^ t2;
      roundKeys[i + 3] = roundKeys[i - key.length + 3] ^ t3;
    }
    return { roundKeys, rounds };
  }

  const aes128ExpandKey = (key) => aesExpandKey(key);

  function aesEncryptBlock(block, roundKeys, rounds) {
    const state = Uint8Array.from(block);
    for (let i = 0; i < 16; i++) state[i] ^= roundKeys[i];
    for (let round = 1; round <= rounds; round++) {
      for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];
      let t = state[1]; state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t;
      t = state[2]; state[2] = state[10]; state[10] = t;
      t = state[6]; state[6] = state[14]; state[14] = t;
      t = state[3]; state[3] = state[15]; state[15] = state[11]; state[11] = state[7]; state[7] = t;
      if (round !== rounds) {
        for (let c = 0; c < 4; c++) {
          const i = c * 4;
          const a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
          state[i] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
          state[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
          state[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
          state[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
        }
      }
      const offset = round * 16;
      for (let i = 0; i < 16; i++) state[i] ^= roundKeys[offset + i];
    }
    return state;
  }

  function aesDecryptBlock(block, roundKeys, rounds) {
    const state = Uint8Array.from(block);
    for (let i = 0; i < 16; i++) state[i] ^= roundKeys[rounds * 16 + i];
    for (let round = rounds - 1; round >= 0; round--) {
      let t = state[13]; state[13] = state[9]; state[9] = state[5]; state[5] = state[1]; state[1] = t;
      t = state[2]; state[2] = state[10]; state[10] = t;
      t = state[6]; state[6] = state[14]; state[14] = t;
      t = state[3]; state[3] = state[7]; state[7] = state[11]; state[11] = state[15]; state[15] = t;
      for (let i = 0; i < 16; i++) state[i] = INV_SBOX[state[i]];
      const offset = round * 16;
      for (let i = 0; i < 16; i++) state[i] ^= roundKeys[offset + i];
      if (round !== 0) {
        for (let c = 0; c < 4; c++) {
          const i = c * 4;
          const a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
          state[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
          state[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
          state[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
          state[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
        }
      }
    }
    return state;
  }

  function aesCbcEncrypt(data, key, iv) {
    const { roundKeys, rounds } = aesExpandKey(key);
    const out = new Uint8Array(data.length);
    let prev = Uint8Array.from(iv);
    for (let offset = 0; offset < data.length; offset += 16) {
      const block = new Uint8Array(16);
      for (let i = 0; i < 16; i++) block[i] = data[offset + i] ^ prev[i];
      const encrypted = aesEncryptBlock(block, roundKeys, rounds);
      out.set(encrypted, offset);
      prev = encrypted;
    }
    return out;
  }

  function aesCbcDecrypt(data, key, iv) {
    const { roundKeys, rounds } = aesExpandKey(key);
    const out = new Uint8Array(data.length);
    let prev = Uint8Array.from(iv);
    for (let offset = 0; offset < data.length; offset += 16) {
      const block = data.subarray(offset, offset + 16);
      const decrypted = aesDecryptBlock(block, roundKeys, rounds);
      for (let i = 0; i < 16; i++) out[offset + i] = decrypted[i] ^ prev[i];
      prev = Uint8Array.from(block);
    }
    return out;
  }

  function pkcs7Pad(data, block = 16) {
    const pad = block - (data.length % block);
    const out = new Uint8Array(data.length + pad);
    out.set(data);
    out.fill(pad, data.length);
    return out;
  }

  function pkcs7Unpad(data, max = 16) {
    if (data.length === 0) return data;
    const pad = data[data.length - 1];
    if (pad > 0 && pad <= max && pad <= data.length) return data.subarray(0, data.length - pad);
    return data;
  }

  function pkcs7UnpadStrict(data, block = 16) {
    const pad = data[data.length - 1];
    if (pad === 0 || pad > block || pad > data.length) throw new Error('pkcs7 填充无效');
    for (let i = data.length - pad; i < data.length; i++) {
      if (data[i] !== pad) throw new Error('pkcs7 填充不一致');
    }
    return data.subarray(0, data.length - pad);
  }

  // ===== Protobuf =====
  // x-argus 的 bean 以 protobuf 编码，此处仅实现写入，不需要解析。

  function writeVarint(value) {
    let v = value & 0xffffffffn;
    const out = [];
    while (v >= 128n) {
      out.push(Number((v & 127n) | 128n));
      v >>= 7n;
    }
    out.push(Number(v & 127n));
    return Uint8Array.from(out);
  }

  class ProtoBuf {
    constructor() { this.fields = []; this.blobs = []; }
    putVarint(index, value) { this.fields.push({ index, type: 0, uint: BigInt(value) }); return this; }
    putBlob(index, data) { this.blobs.push(data); this.fields.push({ index, type: 2, blob: this.blobs.length - 1 }); return this; }
    putUtf8(index, text) { return this.putBlob(index, utf8Bytes(text)); }
    putBytes(index, data) { return this.putBlob(index, data); }
    putProtobuf(index, nested) { return this.putBlob(index, nested.toBuffer()); }
    toBuffer() {
      const chunks = [];
      for (const field of this.fields) {
        const key = (BigInt(field.index) << 3n) | BigInt(field.type & 7);
        chunks.push(writeVarint(key));
        if (field.type === 0) chunks.push(writeVarint(field.uint));
        else if (field.type === 2) {
          const blob = this.blobs[field.blob];
          chunks.push(writeVarint(BigInt(blob.length)));
          chunks.push(blob);
        }
      }
      return concatBytes(...chunks);
    }
  }

  // ===== x-argus =====
  // 主签名：protobuf → PKCS7 → Simon → 分帧 → AES-CBC → base64。

  const ARGUS_SIGN_KEY = 'fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304';
  const ARGUS_AES_KEY = 'd31e3718288a1027baab59f146a09a9c';
  const ARGUS_AES_IV = 'ea180a0336ed352fcd24e4d50018ae54';
  const ARGUS_PREFIX = Uint8Array.from([0xf2, 0x81]);
  const ARGUS_MAGIC8 = Uint8Array.from([0xf2, 0xf7, 0xfc, 0xff, 0xf2, 0xf7, 0xfc, 0xff]);
  const ARGUS_TAIL9 = Uint8Array.from([0xea, 0xfb, 0x2c, 0xfe, 0x85, 0x68, 0x51, 0x91, 0x54]);

  const sm3Prefix6 = (msg) => sm3Hash(msg).subarray(0, 6);
  const argusBodyHash = (stubHex) => !stubHex ? sm3Prefix6(new Uint8Array(16)) : sm3Prefix6(hexToBytes(stubHex));
  const argusQueryHash = (query) => !query ? sm3Prefix6(new Uint8Array(16)) : sm3Prefix6(utf8Bytes(query));

  const simonKeyList = () => {
    const key = hexToBytes(ARGUS_SIGN_KEY);
    return [0, 1, 2, 3].map((i) => readU64LE(key, i * 8));
  };

  function simonEncryptPadded(protobuf) {
    const key = simonKeyList();
    const out = new Uint8Array(protobuf.length);
    for (let i = 0; i < protobuf.length / 16; i++) {
      const offset = i * 16;
      const [c0, c1] = simonEncrypt(readU64LE(protobuf, offset), readU64LE(protobuf, offset + 8), key);
      writeU64LE(out, offset, c0);
      writeU64LE(out, offset + 8, c1);
    }
    return out;
  }

  function argusEncrypt551(bean) {
    const protobuf = pkcs7Pad(bean.toBuffer(), 16);
    const encPb = simonEncryptPadded(protobuf);

    const un = concatBytes(ARGUS_MAGIC8, encPb, ARGUS_TAIL9);
    const buf = new Uint8Array(un.length);
    buf.set(ARGUS_MAGIC8.subarray(0, 8));
    for (let i = 8; i < un.length; i++) buf[i] = un[i] ^ ARGUS_MAGIC8[i % 8];
    buf.reverse();

    const aligned = pkcs7Pad(concatBytes(buf, Uint8Array.from([0x61, 0x6f])), 16);
    const encrypted = aesCbcEncrypt(aligned, hexToBytes(ARGUS_AES_KEY), hexToBytes(ARGUS_AES_IV));
    return bytesToBase64(concatBytes(ARGUS_PREFIX, encrypted));
  }

  function queryParam(queryString, name) {
    if (!queryString) return '';
    for (const part of queryString.split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = decodeURIComponent(part.slice(0, eq).replace(/\+/g, ' '));
      if (key !== name) continue;
      return decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    }
    return '';
  }

  function argusGetSign(params) {
    const aid = params.aid || 1967;
    const licenseId = params.licenseId || 1611921764;
    const randField = params.randField === undefined || params.randField === 0
      ? new DataView(randomBytes(4).buffer).getInt32(0, true)
      : params.randField;

    const bean = new ProtoBuf();
    bean.putVarint(1, 1077940818);
    bean.putVarint(2, 2);
    bean.putVarint(3, randField);
    bean.putUtf8(4, String(aid));
    bean.putUtf8(5, params.deviceId || '');
    bean.putUtf8(6, String(licenseId));
    bean.putUtf8(7, queryParam(params.queryString, 'version_name'));
    bean.putUtf8(8, 'v04.04.05-ov-android');
    bean.putVarint(9, 134744640);
    bean.putBytes(10, new Uint8Array(8));
    bean.putVarint(11, 0);
    bean.putVarint(12, params.timestamp * 2);
    bean.putBytes(13, argusBodyHash(params.stubHex || ''));
    bean.putBytes(14, argusQueryHash(params.queryString || ''));

    const sub15 = new ProtoBuf();
    sub15.putVarint(1, 1);
    sub15.putVarint(2, 1);
    sub15.putVarint(3, 1);
    sub15.putVarint(7, 0xc792eccc);
    bean.putProtobuf(15, sub15);

    bean.putUtf8(16, params.installId || '');
    bean.putUtf8(20, 'none');
    bean.putVarint(21, 738);

    const sub23 = new ProtoBuf();
    sub23.putUtf8(1, 'NX551J');
    sub23.putVarint(2, 8196);
    sub23.putVarint(4, 0x80e0d800);
    bean.putProtobuf(23, sub23);

    bean.putVarint(25, 2);
    return argusEncrypt551(bean);
  }

  // ===== x-ladon =====
  // 独立签名头，基于 34 轮 ARX 分组密码。

  function ladonExpandHashTable(md5HexValue) {
    const ht = new Uint8Array(288);
    const bytes = utf8Bytes(md5HexValue);
    ht.set(bytes.subarray(0, Math.min(32, bytes.length)));

    const load = (offset) => {
      let v = 0n;
      for (let j = 0; j < 8; j++) v |= BigInt(ht[offset + j]) << BigInt(j * 8);
      return v;
    };

    const temp = [load(0), load(8), load(16), load(24)];
    let bufB0 = temp[0], bufB8 = temp[1];
    temp.splice(0, 2);

    for (let i = 0; i < 34; i++) {
      const x9 = bufB0;
      let x8 = bufB8;
      x8 = rotr64(x8, 8);
      x8 = (x8 + x9) & MASK64;
      x8 ^= BigInt(i);
      temp.push(x8);
      x8 ^= rotl64(x9, 3);
      for (let j = 0; j < 8; j++) ht[(i + 1) * 8 + j] = Number((x8 >> BigInt(j * 8)) & 0xffn);
      bufB0 = x8;
      bufB8 = temp[0];
      temp.shift();
    }
    return ht;
  }

  function ladonEncryptBlock(ht, block) {
    let data0 = readU64LE(block, 0), data1 = readU64LE(block, 8);
    for (let i = 0; i < 34; i++) {
      let hash = 0n;
      for (let j = 0; j < 8; j++) hash |= BigInt(ht[i * 8 + j]) << BigInt(j * 8);
      data1 = hash ^ ((data0 + rotr64(data1, 8)) & MASK64);
      data0 = data1 ^ rotl64(data0, 3);
    }
    const out = new Uint8Array(16);
    writeU64LE(out, 0, data0);
    writeU64LE(out, 8, data1);
    return out;
  }

  function ladonEncryptRaw(md5HexValue, data) {
    const ht = ladonExpandHashTable(md5HexValue);
    const newSize = data.length + (16 - (data.length % 16));
    const input = new Uint8Array(newSize);
    input.set(data);
    input.fill(newSize - data.length, data.length);
    const out = new Uint8Array(newSize);
    for (let i = 0; i < newSize / 16; i++) {
      out.set(ladonEncryptBlock(ht, input.subarray(i * 16, i * 16 + 16)), i * 16);
    }
    return out;
  }

  function ladonEncrypt(khronos, lcId, aid, randomBytes4) {
    const data = utf8Bytes(`${khronos}-${lcId}-${aid}`);
    const keygen = concatBytes(randomBytes4, utf8Bytes(String(aid)));
    const encrypted = ladonEncryptRaw(md5Hex(keygen), data);
    return bytesToBase64(concatBytes(randomBytes4, encrypted));
  }

  // ===== 签名头 =====
  // 组装上游要求的全部签名头：x-argus / x-ladon / x-khronos / x-ss-stub。

  function signHeaders(opts) {
    const ts = opts.timestamp || Math.floor(Date.now() / 1000);
    const aid = opts.aid || 1967;
    const licenseId = opts.licenseId || 1611921764;
    const queryString = opts.queryString || '';

    let stubHex = '';
    if (opts.body && opts.body.length > 0) stubHex = md5Hex(opts.body);

    const headers = {
      'x-ss-req-ticket': String(ts * 1000),
      'x-khronos': String(ts),
      'x-ladon': ladonEncrypt(ts, licenseId, aid, randomBytes(4)),
    };
    headers['x-argus'] = argusGetSign({
      queryString,
      stubHex,
      timestamp: ts,
      aid,
      licenseId,
      deviceId: queryParam(queryString, 'device_id') || opts.deviceId || '',
      installId: opts.installId || '',
    });
    if (stubHex) headers['x-ss-stub'] = stubHex;
    return headers;
  }

  // ===== 设备注册加密 =====
  // 负责设备注册请求体的加密，以及注册响应中密钥的解密。

  const TT_FIXED_STRING_B64 = 'TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==';
  const TT_MAGIC = Uint8Array.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
  const REGISTER_KEY_MASTER = 'ac25c67ddd8f38c1b37a2348828e222e';
  const REGISTER_KEY_REQ_KEY_B64 = 'rCXGfd2POMGzeiNIgo4iLg==';

  function ttEncrypt(data, randomBytes32) {
    const rnd = randomBytes32 || randomBytes(32);
    const fixed = base64ToBytes(TT_FIXED_STRING_B64);
    const hv = sha512(concatBytes(sha512(rnd), fixed));
    const aesKey = hv.subarray(0, 16);
    const aesIv = hv.subarray(16, 32);
    const padded = pkcs7Pad(concatBytes(sha512(data), data), 16);
    return concatBytes(TT_MAGIC, rnd, aesCbcEncrypt(padded, aesKey, aesIv));
  }

  function decryptRegisterKey(encryptedKeyB64) {
    const data = base64ToBytes(encryptedKeyB64);
    if (data.length < 16) throw new Error('registerkey 数据过短');
    const key = hexToBytes(REGISTER_KEY_MASTER);
    const ct = data.subarray(16);
    if (ct.length === 0 || ct.length % 16 !== 0) throw new Error('registerkey 密文无效');
    return pkcs7UnpadStrict(aesCbcDecrypt(ct, key, data.subarray(0, 16)), 16);
  }

  function reverseHex(deviceId) {
    if (!/^\d+$/.test(deviceId)) throw new Error('device_id 不是数字');
    const hex = BigInt(deviceId).toString(16).padStart(32, '0');
    let out = '';
    for (let i = hex.length; i >= 2; i -= 2) out += hex[i - 2] + hex[i - 1];
    return out;
  }

  function encryptRegisterKeyRequest(deviceId) {
    const key = base64ToBytes(REGISTER_KEY_REQ_KEY_B64);
    const iv = randomBytes(16);
    const padded = pkcs7Pad(hexToBytes(reverseHex(deviceId)), 16);
    return bytesToBase64(concatBytes(iv, aesCbcEncrypt(padded, key, iv)));
  }

  // ===== 设备缓存 =====
  // 注册流程需连续调用四个接口，结果必须缓存复用。优先使用油猴存储，
  // 不可用时回退到 localStorage。

  const CACHE_KEY = 'fanqie_device_v1';

  function loadDevice() {
    try {
      const raw = typeof GM_getValue === 'function'
        ? GM_getValue(CACHE_KEY, null)
        : JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!raw) return null;
      const device = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!device.deviceId || !device.installId || !device.secretKey) return null;
      return device;
    } catch (_) {
      return null;
    }
  }

  function saveDevice(device) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(CACHE_KEY, device);
      else localStorage.setItem(CACHE_KEY, JSON.stringify(device));
    } catch (_) {}
  }

  function clearDevice() {
    try {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(CACHE_KEY);
      else localStorage.removeItem(CACHE_KEY);
    } catch (_) {}
  }

  // ===== 网络 =====
  // 油猴环境下使用 GM_xmlhttpRequest 规避跨域限制；不可用时回退到 fetch。

  function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const gm = typeof GM_xmlhttpRequest === 'function'
        ? GM_xmlhttpRequest
        : typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest : null;
      if (!gm) {
        fetch(url, { method: options.method || 'GET', headers: options.headers || {}, body: options.body })
          .then(async (r) => resolve({ status: r.status, body: new Uint8Array(await r.arrayBuffer()) }))
          .catch(reject);
        return;
      }
      gm({
        method: options.method || 'GET',
        url,
        headers: options.headers || {},
        data: options.body,
        responseType: 'arraybuffer',
        timeout: 30000,
        onload: (r) => resolve({ status: r.status, body: new Uint8Array(r.response || new ArrayBuffer(0)) }),
        onerror: () => reject(new Error('网络请求失败')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  async function gzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ===== 设备注册 =====
  // 依次调用 device_register → app_alert_check → privilege/add → registerkey。

  const PKG_NAME = 'com.dragon.read';
  const SDK_VERSION = 'v04.04.05-ov-android';
  const HOST_FQNOVEL = 'https://api5-normal-sinfonlineb.fqnovel.com';

  function goQueryEscape(text) {
    let out = '';
    for (const byte of utf8Bytes(text)) {
      if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
          (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x5f ||
          byte === 0x2e || byte === 0x7e) {
        out += String.fromCharCode(byte);
      } else if (byte === 0x20) out += '+';
      else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }

  const sortedQuery = (pairs) => pairs.slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${goQueryEscape(k)}=${goQueryEscape(v)}`).join('&');

  function randomHexLower(n) {
    const hex = '0123456789abcdef';
    const bytes = randomBytes(n);
    let out = '';
    for (let i = 0; i < n; i++) out += hex[bytes[i] % 16];
    return out;
  }

  function randomAlnum(n) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const bytes = randomBytes(n);
    let out = '';
    for (let i = 0; i < n; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  function uuidV4() {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytesToHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function newDeviceInfo() {
    const openudid = randomHexLower(16);
    const deviceType = 'MI 12';
    const osVersion = '10';
    const manifestVersionCode = '65132';
    const ttNet = 'TTNetVersion:9ac8d95c 2024-11-25 QuicVersion:3f326df4 2024-11-14';
    return {
      deviceType, osApi: '29', osVersion, openudid,
      resolution: '1440*2392', dpi: '560',
      cdid: uuidV4(), clientudid: uuidV4(),
      rom: `EMUI-${randomAlnum(13)}`, romVersion: randomAlnum(2),
      deviceBrand: 'Xiaomi', channel: 'xiaomi_1967_64',
      versionCode: '65132', versionName: '6.5.1.32', manifestVersionCode,
      updateVersionCode: '65132',
      userAgent: `com.dragon.read/${manifestVersionCode} (Linux; U; Android ${osVersion}; zh_CN; ${deviceType}; Build/MMB29M; Cronet/${ttNet})`,
    };
  }

  function deviceUrlParams(info, extra = []) {
    let pairs = [
      ['tt_data', 'a'], ['os_api', info.osApi], ['device_type', info.deviceType],
      ['ssmix', 'a'], ['manifest_version_code', info.manifestVersionCode],
      ['dpi', info.dpi], ['version_name', info.versionName], ['ts', String(Math.floor(Date.now() / 1000))],
      ['cpu_support64', 'true'], ['app_type', 'normal'], ['appTheme', 'light'],
      ['ac', 'wifi'], ['host_abi', 'arm64-v8a'], ['update_version_code', info.updateVersionCode],
      ['channel', info.channel], ['_rticket', String(Date.now())], ['device_platform', 'android'],
      ['version_code', info.versionCode], ['cdid', info.cdid], ['os', 'android'],
      ['is_android_pad', '0'], ['openudid', info.openudid], ['package', PKG_NAME],
      ['resolution', info.resolution], ['os_version', info.osVersion], ['language', 'zh'],
      ['device_brand', info.deviceBrand], ['need_personal_recommend', '1'], ['aid', '1967'],
      ['minor_status', '0'], ['app_name', 'novel'], ['mcc_mnc', '46007'],
    ];
    for (const [key, value] of extra) {
      pairs = pairs.filter(([k]) => k !== key);
      pairs.push([key, value]);
    }
    return pairs;
  }

  async function deviceRegister(info) {
    const header = {
      display_name: '番茄小说', update_version_code: info.updateVersionCode,
      manifest_version_code: info.manifestVersionCode, aid: 1967,
      channel: info.channel, package: PKG_NAME, app_version: info.versionName,
      version_code: info.versionCode, sdk_version: SDK_VERSION, sdk_target_version: 29,
      os: 'Android', os_version: info.osVersion, os_api: info.osApi,
      device_model: info.deviceType, device_brand: info.deviceBrand,
      device_manufacturer: 'Google', device_category: 'phone', cpu_abi: 'arm64-v8a',
      release_build: uuidV4(), density_dpi: info.dpi, display_density: 'mdpi',
      resolution: info.resolution.replace('*', 'x'), language: 'zh',
      mac: Array.from(randomBytes(6), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':'),
      timezone: 8, access: 'wifi', not_request_sender: 0, carrier: 'CHINA MOBILE',
      mcc_mnc: '46007', rom: info.rom, rom_version: info.romVersion,
      sig_hash: md5Hex(uuidV4()), openudid: info.openudid, clientudid: info.clientudid,
      sim_serial_number: [], region: 'CN', tz_name: 'Asia/Shanghai',
      tz_offset: 28800, sim_region: 'cn',
    };
    const body = { magic_tag: 'ss_app_log', header, _gen_time: Date.now() };
    const gz = await gzip(utf8Bytes(JSON.stringify(body)));
    const postData = ttEncrypt(gz);

    const query = sortedQuery(deviceUrlParams(info));
    const response = await httpRequest(`https://log.snssdk.com/service/2/device_register/?${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream;tt-data=a',
        'accept-encoding': 'gzip',
        'user-agent': info.userAgent,
      },
      body: postData,
    });
    if (response.status !== 200) throw new Error(`设备注册 HTTP ${response.status}`);
    const payload = JSON.parse(utf8Decode(response.body));
    const deviceId = String(payload.device_id_str || payload.device_id || '');
    const installId = String(payload.install_id_str || payload.install_id || '');
    if (!deviceId || !installId) throw new Error('设备注册响应缺少 id');
    return { deviceId, installId };
  }

  async function registerKey(deviceId, installId) {
    const content = encryptRegisterKeyRequest(deviceId);
    const parts = [
      'aid=1967', 'app_name=novelapp', 'channel=0', `device_id=${deviceId}`,
      'device_platform=android', `iid=${installId}`, 'os_version=0',
      'version_code=6.1.5.32', 'version_name=6.1.5.32',
    ].sort();
    const paramString = parts.join('&');
    const compressed = await gzip(utf8Bytes(JSON.stringify({ content })));
    const headers = signHeaders({ queryString: paramString, body: compressed, installId });

    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await httpRequest(
          `https://reading.snssdk.com/reading/crypt/registerkey?${paramString}`,
          {
            method: 'POST',
            headers: { 'User-Agent': 'com.dragon.read', 'Content-Encoding': 'gzip', ...headers },
            body: compressed,
          },
        );
        if (response.status !== 200) {
          lastError = `HTTP ${response.status}`;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const payload = JSON.parse(utf8Decode(response.body));
        const key = String((payload.data && payload.data.key) || '');
        if (!key) {
          lastError = '响应缺少 key';
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const decrypted = decryptRegisterKey(key);
        if (decrypted.length === 0) {
          lastError = '解密得到空密钥';
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        return bytesToHexUpper(decrypted);
      } catch (error) {
        lastError = error.message;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`获取设备密钥失败: ${lastError}`);
  }

  async function registerDevice() {
    const info = newDeviceInfo();
    const { deviceId, installId } = await deviceRegister(info);
    try {
      const query = sortedQuery(deviceUrlParams(info, [['device_id', deviceId], ['iid', installId]]));
      await httpRequest(`https://ichannel.snssdk.com/service/2/app_alert_check/?${query}`, {
        headers: {
          'content-type': 'application/octet-stream;tt-data=a',
          'accept-encoding': 'gzip', 'log-encode-type': 'gzip',
          'x-tt-request-tag': 't=0;n=1', 'sdk-version': '2',
          'passport-sdk-version': info.versionCode,
          'x-vc-bdturing-sdk-version': '3.7.4.cn',
          'user-agent': info.userAgent,
          ...signHeaders({ queryString: query, installId }),
        },
      });
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const parts = [
        'aid=1967', 'app_name=novelapp', 'channel=0', `device_id=${deviceId}`,
        'device_platform=android', `device_type=${info.deviceType}`, `iid=${installId}`,
        'os_version=0', 'version_code=61532', 'version_name=6.1.5.32',
        'manifest_version_code=61532', 'update_version_code=61532',
      ].sort();
      await httpRequest(
        `https://api5-normal-sinfonlinea.fqnovel.com/reading/user/privilege/add/v/?${parts.join('&')}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: utf8Bytes(JSON.stringify({
            add_count_daily: 0, amount: 2592000, privilege_id: 7210376203117531962,
            from: 8, unique_key: String(Date.now()),
          })),
        },
      );
    } catch (_) {}
    const secretKey = await registerKey(deviceId, installId);
    return { deviceId, installId, secretKey, cdid: info.cdid, openudid: info.openudid, createdAt: Date.now() };
  }

  async function ensureDevice() {
    const cached = loadDevice();
    if (cached) return cached;
    const device = await registerDevice();
    saveDevice(device);
    return device;
  }

  // ===== 正文 =====
  // 两个接口取回的正文逐字节相同（实测 sha256 一致），差异在请求拼装与解析路径：
  //   full   单章，参数 item_id；正文取 data.content，标题取 data.title
  //   batch  批量，参数 item_ids + book_id=0 + req_type=1；
  //          响应为 { itemId: {...} } 字典，需先按 itemId 取子对象再读 content
  // 两者均带 novel_text_type=0：实测缺省与 =1 等价，都会附加 XML 声明与
  // <h1 class="chapterTitle1"> 标题节点；=0 才返回干净正文片段。
  // 实际使用哪个由设置决定，失败时自动回退到另一个。

  const FULL_URL = 'https://reading.snssdk.com/reading/reader/full/v/';
  const BATCH_URL = 'https://api5-normal-sinfonlineb.fqnovel.com/reading/reader/batch_full/v';

  const SETTINGS_KEY = 'fanqie_settings_v1';

  function loadSettings() {
    try {
      const raw = typeof GM_getValue === 'function'
        ? GM_getValue(SETTINGS_KEY, null)
        : JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        api: saved && saved.api === 'batch' ? 'batch' : 'full',
        prefetch: !!(saved && saved.prefetch),
      };
    } catch (_) {
      return { api: 'full', prefetch: false };
    }
  }

  function saveSettings(settings) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(SETTINGS_KEY, settings);
      else localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {}
  }

  function baseQuery(device) {
    return [
      'aid=1967', 'app_name=novelapp', 'channel=0', 'device_platform=android',
      `device_id=${device.deviceId}`, 'device_type=Honor10',
      'os_version=0', 'version_code=66.9', 'novel_text_type=0',
    ];
  }

  async function decryptContent(encryptedB64, secretKeyHex) {
    const raw = base64ToBytes(encryptedB64);
    if (raw.length < 16) throw new Error('密文过短');
    const key = hexToBytes(secretKeyHex);
    const ct = raw.subarray(16);
    if (ct.length % 16 !== 0) throw new Error('密文未对齐');
    let plain = pkcs7Unpad(aesCbcDecrypt(ct, key, raw.subarray(0, 16)), 16);
    if (plain.length >= 2 && plain[0] === 0x1f && plain[1] === 0x8b) plain = await gunzip(plain);
    return utf8Decode(plain);
  }

  async function requestJson(url, query, device) {
    const response = await httpRequest(`${url}?${query}`, {
      headers: {
        'User-Agent': 'com.dragon.read',
        Accept: 'application/json',
        ...signHeaders({ queryString: query, deviceId: device.deviceId, installId: device.installId }),
      },
    });
    if (response.status !== 200) throw new Error(`正文接口 HTTP ${response.status}`);
    const text = utf8Decode(response.body);
    if (!text.trim()) throw new Error('正文接口返回空响应（签名被拒或设备失效）');
    return JSON.parse(text);
  }

  async function fetchByFull(itemId, device) {
    const query = [...baseQuery(device), `item_id=${itemId}`].join('&');
    const payload = await requestJson(FULL_URL, query, device);
    const data = payload.data || {};
    const content = String(data.content || '');
    if (!content) throw new Error('响应里没有正文');
    const novel = data.novel_data || {};
    return {
      title: String(data.title || ''),
      content: await decryptContent(content, device.secretKey),
      // next_item_id 供预加载定位下一章；章节末章时为空。
      nextItemId: String(novel.next_item_id || ''),
      bookId: String(novel.book_id || ''),
    };
  }

  async function fetchByBatch(itemId, device) {
    const query = [...baseQuery(device), 'book_id=0', `item_ids=${itemId}`, 'req_type=1'].join('&');
    const payload = await requestJson(BATCH_URL, query, device);
    const data = payload.data || {};
    const item = data[itemId] || {};
    if (item.code && item.code !== 0) throw new Error(`batch 返回 ${item.code}`);
    const content = String(item.content || '');
    if (!content) throw new Error('响应里没有正文');
    const novel = item.novel_data || {};
    return {
      title: String(item.title || ''),
      content: await decryptContent(content, device.secretKey),
      nextItemId: String(novel.next_item_id || ''),
      bookId: String(novel.book_id || ''),
    };
  }

  // ===== 预加载 =====
  // 读到下一章 ID 后提前取回并缓存，切章时直接命中，省掉一次往返。
  // 两个接口的机制相同：都是拿到当前章响应、从 novel_data.next_item_id
  // 读到下一章 ID 后，再单独发一次请求取回。请求次数一致。
  // 注意：无法把下一章并入当前请求——该 ID 只出现在当前章的响应里。

  const PREFETCH_LIMIT = 3;
  const prefetched = new Map();

  function prefetchGet(itemId) {
    return prefetched.get(itemId) || null;
  }

  function prefetchPut(chapter) {
    if (!chapter || !chapter.itemId || !chapter.content) return;
    prefetched.set(chapter.itemId, chapter);
    // 只保留最近若干章，避免长时间阅读后无限增长。
    while (prefetched.size > PREFETCH_LIMIT) {
      prefetched.delete(prefetched.keys().next().value);
    }
  }

  function prefetchClear() {
    prefetched.clear();
  }

  async function fetchChapter(itemId, device) {
    const settings = loadSettings();
    const useBatch = settings.api === 'batch';
    const first = useBatch ? fetchByBatch : fetchByFull;
    const second = useBatch ? fetchByFull : fetchByBatch;

    let chapter;
    try {
      chapter = await first(itemId, device);
    } catch (error) {
      console.warn(`${LOG} ${settings.api} 接口失败（${error.message}），改用另一个接口`);
      chapter = await second(itemId, device);
    }

    // 无论是否开启预加载都记录下一章 ID：这样中途打开开关时能立即预取。
    nextChapterId = chapter.nextItemId || '';

    if (settings.prefetch && nextChapterId) {
      // 两种接口机制相同：拿到当前章响应、读到下一章 ID 后，再单独请求一次。
      if (useBatch) prefetchOneViaBatch(nextChapterId, device);
      else prefetchOne(nextChapterId, device);
    }
    return chapter;
  }

  // full 模式下单独预取下一章；失败静默，不影响当前章节显示。
  async function prefetchOne(itemId, device) {
    if (!itemId || prefetchGet(itemId)) return;
    try {
      const settings = loadSettings();
      if (!settings.prefetch) return;
      const chapter = await fetchByFull(itemId, device);
      if (settings.api === 'batch') {
        // 期间切换了接口，丢弃结果，避免与 batch 缓存混淆。
        return;
      }
      prefetchPut({ itemId, ...chapter });
      console.log(`${LOG} 已预加载第 ${itemId} 章（${chapter.content.length} 字符）`);
    } catch (error) {
      console.log(`${LOG} 预加载 ${itemId} 失败（${error.message}），切换时按需加载`);
    }
  }

  // batch 模式下预取下一章：单独发一次批量请求，只带这一章。
  async function prefetchOneViaBatch(itemId, device) {
    if (!itemId || prefetchGet(itemId)) return;
    try {
      const settings = loadSettings();
      if (!settings.prefetch || settings.api !== 'batch') return;
      const chapter = await fetchByBatch(itemId, device);
      prefetchPut({ itemId, ...chapter });
      console.log(`${LOG} 已预加载第 ${itemId} 章（${chapter.content.length} 字符）`);
    } catch (error) {
      console.log(`${LOG} 预加载 ${itemId} 失败（${error.message}），切换时按需加载`);
    }
  }

  // ===== 页面操作 =====
  // 约束：不得删除或改写阅读区内由 React 管理的节点。
  // 阅读器为单页应用，切章时 React 依据自身虚拟 DOM 对 <p> 与遮挡层执行
  // removeChild。若脚本已移除这些节点，React 将抛出 NotFoundError，由
  // error boundary 捕获后卸载整个 #app，页面变为空白。
  // 因此此处只做两件事：以 CSS 隐藏原始节点（保留在 DOM 中），以及在独立
  // 创建的容器内渲染正文。

  const LOG = '[番茄阅读]';
  const BODY_ID = 'fq-reader-body';
  const STYLE_ID = 'fq-reader-style';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      // 原始正文与遮挡层仅隐藏、不删除，避免打断 React 的节点回收。
      `.muye-reader-content > :not(#${BODY_ID}) { display: none !important; }`,
      '.muye-to-fanqie { display: none !important; }',
      `#${BODY_ID} p { margin: 0 0 0.8em; }`,
      // 设置面板：固定在右下角，不参与正文排版。
      `#${PANEL_ID} {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        display: flex; flex-direction: column; gap: 4px;
        padding: 6px 10px; border-radius: 6px;
        background: rgba(255, 255, 255, 0.94);
        border: 1px solid rgba(0, 0, 0, 0.12);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
        font: 12px/1.5 -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
        color: #333;
      }`,
      `#${PANEL_ID} .fq-row { display: flex; align-items: center; gap: 6px; }`,
      `#${PANEL_ID} select {
        font: inherit; color: inherit; padding: 2px 4px;
        border: 1px solid rgba(0, 0, 0, 0.15); border-radius: 4px;
        background: #fff; cursor: pointer;
      }`,
      `#${PANEL_ID} .fq-switch { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }`,
      `#${PANEL_ID} .fq-switch input { margin: 0; cursor: pointer; }`,
      '@media (prefers-color-scheme: dark) {',
      `  #${PANEL_ID} { background: rgba(40, 40, 40, 0.94); color: #ddd; border-color: rgba(255, 255, 255, 0.15); }`,
      `  #${PANEL_ID} select { background: #2a2a2a; color: #ddd; border-color: rgba(255, 255, 255, 0.2); }`,
      '}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function getItemId() {
    const match = /\/reader\/(\d{1,20})/.exec(location.pathname + location.search);
    return match ? match[1] : null;
  }

  function findContentContainer() {
    const nodes = Array.from(document.querySelectorAll('.muye-reader-content'));
    return nodes.find((n) => n.classList.contains('noselect')) ||
      nodes.find((n) => n.querySelector('p')) || nodes[0] || null;
  }

  function htmlToLines(html) {
    return String(html)
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      // h1 为块级元素，需单独换行，否则标题与首段合并为一行。
      .replace(/<\s*\/?\s*h1[^>]*>/gi, '\n')
      .replace(/<\s*\/?\s*(?:p|div|article|header|footer)(?=[\s/>])[^>]*>/gi, '\n')
      .split('\n')
      .map((line) => line.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)
      .map((line) => line
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  }

  function renderContent(container, html) {
    const lines = htmlToLines(html);
    const pageTitle = document.querySelector('.muye-reader-title')?.textContent.trim();

    let body = container.querySelector(`#${BODY_ID}`);
    if (!body) {
      body = document.createElement('div');
      body.id = BODY_ID;
      container.appendChild(body);
    }
    // 仅清空脚本自建容器，React 不持有该节点。
    body.textContent = '';
    for (const line of lines) {
      // novel_text_type=0 时上游不返回标题，此处仅作兜底，避免重复一行。
      if (pageTitle && line === pageTitle) continue;
      const p = document.createElement('p');
      p.textContent = line;
      body.appendChild(p);
    }
    return lines.length;
  }

  function hidePaywall() {
    // 遮挡层已由 ensureStyle() 中的 CSS 隐藏，此处仅统计数量用于日志。
    return document.querySelectorAll('.muye-to-fanqie').length;
  }

  let currentItemId = null;
  let running = false;
  // 已知的下一章 ID，由上一次正文响应的 novel_data.next_item_id 得到。
  let nextChapterId = '';

  async function run() {
    const itemId = getItemId();
    if (!itemId || running || itemId === currentItemId) return;

    const container = findContentContainer();
    if (!container) return;

    running = true;
    try {
      const device = await ensureDevice();

      // 命中预加载缓存时无需再发请求。
      const cached = prefetchGet(itemId);
      let chapter;
      let fromCache = false;
      if (cached) {
        chapter = cached;
        fromCache = true;
        prefetched.delete(itemId);
      } else {
        chapter = await fetchChapter(itemId, device);
      }

      // 请求期间可能已切换章节，丢弃过期结果。
      if (getItemId() !== itemId) return;

      // 命中缓存时不会经过 fetchChapter，需在此更新下一章并接力预取，
      // 否则预加载链在第二次切章后断开。
      if (fromCache) {
        const settings = loadSettings();
        nextChapterId = chapter.nextItemId || '';
        if (settings.prefetch && nextChapterId) {
          if (settings.api === 'batch') {
            // batch 模式下用批量接口单独请求再下一章。
            prefetchOneViaBatch(nextChapterId, device);
          } else {
            prefetchOne(nextChapterId, device);
          }
        }
      }

      ensureStyle();
      const count = renderContent(container, chapter.content);
      const removed = hidePaywall();
      ensurePanel();
      currentItemId = itemId;
      console.log(
        `${LOG} 第 ${itemId} 章已替换（${count} 段 / ${chapter.content.length} 字符${fromCache ? '，来自预加载' : ''}）`,
        chapter.title,
        removed ? `隐藏 ${removed} 个遮挡层` : '',
      );
    } catch (error) {
      console.warn(`${LOG} 替换失败（${itemId}）：${error.message}`);
      if (String(error.message).includes('空响应')) {
        console.warn(`${LOG} 可执行 __fanqieReset() 更换设备身份后重试`);
      }
    } finally {
      running = false;
    }
  }

  globalThis.__fanqieReset = () => {
    clearDevice();
    currentItemId = null;
    prefetchClear();
    nextChapterId = '';
    console.log(`${LOG} 设备缓存已清除，下次运行将重新注册`);
  };

  // 油猴菜单提供设备缓存清理入口，等价于控制台执行 __fanqieReset()。
  // 清除后立即重新拉取当前章节，否则页面仍显示旧设备取回的正文。
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('清除设备缓存（重新注册）', () => {
      globalThis.__fanqieReset();
      run();
    });
  }

  // ===== 设置面板 =====
  // 油猴菜单的单项切换在部分管理器下状态不同步（菜单文案不会随设置刷新），
  // 改为页面内下拉框，两个选项直接对应两个接口。
  // 面板挂在 body 下：React 只管理 #app，不会回收该节点。

  const PANEL_ID = 'fq-reader-panel';
  const API_LABELS = { full: 'full（单章）', batch: 'batch_full（批量）' };

  function switchApi(next) {
    const api = next === 'batch' ? 'batch' : 'full';
    const settings = loadSettings();
    saveSettings({ ...settings, api });
    currentItemId = null;
    // 接口换了，旧接口取回的预加载内容不再可信。
    prefetchClear();
    nextChapterId = '';
    const select = document.querySelector(`#${PANEL_ID} select`);
    if (select && select.value !== api) select.value = api;
    console.log(`${LOG} 正文接口已切换为 ${api}`);
    run();
  }

  async function switchPrefetch(enabled) {
    const settings = loadSettings();
    saveSettings({ ...settings, prefetch: !!enabled });
    const checkbox = document.querySelector(`#${PANEL_ID} input[type="checkbox"]`);
    if (checkbox) checkbox.checked = !!enabled;
    if (enabled) {
      console.log(`${LOG} 已开启预加载`);
      // 立即为当前章节补一次预取。nextChapterId 来自当前章的响应。
      const next = nextChapterId;
      if (next) {
        try {
          const device = await ensureDevice();
          const now = loadSettings();
          if (now.api === 'batch') prefetchOneViaBatch(next, device);
          else prefetchOne(next, device);
        } catch (_) {}
      }
    } else {
      prefetchClear();
      nextChapterId = '';
      console.log(`${LOG} 已关闭预加载`);
    }
  }

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    // 第一行：正文接口下拉框。
    const rowApi = document.createElement('div');
    rowApi.className = 'fq-row';
    const label = document.createElement('span');
    label.textContent = '正文接口';
    const select = document.createElement('select');
    for (const [value, text] of Object.entries(API_LABELS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }
    select.value = loadSettings().api;
    select.addEventListener('change', () => switchApi(select.value));
    rowApi.appendChild(label);
    rowApi.appendChild(select);

    // 第二行：预加载开关。
    const rowPrefetch = document.createElement('div');
    rowPrefetch.className = 'fq-row';
    const pfLabel = document.createElement('label');
    pfLabel.className = 'fq-switch';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!loadSettings().prefetch;
    checkbox.addEventListener('change', () => switchPrefetch(checkbox.checked));
    const pfText = document.createElement('span');
    pfText.textContent = '提前加载下一章';
    pfLabel.appendChild(checkbox);
    pfLabel.appendChild(pfText);
    rowPrefetch.appendChild(pfLabel);

    panel.appendChild(rowApi);
    panel.appendChild(rowPrefetch);
    document.body.appendChild(panel);
  }

  globalThis.__fanqieApi = switchApi;
  globalThis.__fanqiePrefetch = switchPrefetch;

  // 首屏也要有面板：run() 拿到正文后才建，若接口失败面板会缺失。
  function boot() {
    ensureStyle();
    ensurePanel();
    run();
  }

  boot();

  const observer = new MutationObserver(() => {
    if (getItemId() !== currentItemId) run();
  });

  function startObserving() {
    const target = findContentContainer()?.parentElement;
    if (!target) return false;
    observer.observe(target, { childList: true, subtree: true });
    return true;
  }

  if (!startObserving()) {
    document.addEventListener('DOMContentLoaded', () => {
      startObserving();
      run();
    });
  }

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      currentItemId = null;
      // 切章后 React 可能整块替换阅读区，面板若被移除则重建。
      ensurePanel();
      run();
    }
  }, 800);
})();
