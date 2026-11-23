/* ============================================================
   质量系统 · 共享内核  quality/qa-core.js
   ------------------------------------------------------------
   【build .163】本文件是质量系统「全工程唯一一份」的纯函数内核，
   前端（<script src="qa-core.js">）与后端（require）加载**同一份字节**。

   双形态外壳（设计 §3.2 / §1.2.6e）：
     · Node（CommonJS）：typeof module === 'object' && module.exports ⇒ module.exports
     · 浏览器          ：挂到 window.QA_CORE
   因此本文件内**零 require、零 DOM 引用、零 IO、零全局副作用**。
   改动本文件等于同时改动前后端两个消费者，请先确认两侧调用点。

   约定（设计 §8.1）：
     · 编号只允许一份实现 = 本文件的 nextQaNo()
     · 编号日期段取「发号当日」而非用户填的 date（跨零点差异由服务端 409 + suggest 兜住）
     · 时间戳统一 ISO 8601 UTC（Z 后缀），日期串统一 'YYYY-MM-DD' 本地口径
   ============================================================ */
(function (global) {
  'use strict';

  function factory() {
    /* ---------- 常量（UI 与后端共用，禁止在别处再写一份字面量） ---------- */
    var NO_PREFIX = 'YC';                      /* 编号前缀（PRD Q2 默认值，上线后不可逆） */
    var DEFAULT_PAGE_SIZE = 100;               /* PRD 5.3：默认每页 100 条 */
    var PAGE_SIZES = [10, 100, 1000];          /* PRD 5.3：仅这三档 */
    var NO_RE = /^YC-\d{8}-\d{5}$/;            /* 编号格式（设计 §1.2.3c） */
    var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;       /* 日期串格式 */

    /* ---------- 内部小工具 ---------- */

    /** 两位补零（todayStr 专用，避免依赖 padStart 的兼容性差异） */
    function pad2(n) {
      return (n < 10 ? '0' : '') + n;
    }

    /** 把任意入参归一为 Date；非法入参退化为「当前时刻」而非抛错（纯函数不抛异常） */
    function toDate(now) {
      var d;
      if (now instanceof Date) d = now;
      else if (now === undefined || now === null || now === '') d = new Date();
      else d = new Date(now);
      if (!(d instanceof Date) || isNaN(d.getTime())) d = new Date();
      return d;
    }

    /**
     * 本地时区的 'YYYY-MM-DD'。
     * 刻意不用 `new Date().toISOString().slice(0,10)`：那是 UTC，东八区晚 8 小时会在
     * 23:00 之后把「今天」算成「明天」/ 或反之，直接导致跨日发号错段（设计 §3.2 明确禁用）。
     * @param {Date=} now 可选，缺省为当前时刻
     * @returns {string} 'YYYY-MM-DD'（本地时区）
     */
    function todayStr(now) {
      var d = toDate(now);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    /**
     * 由日期串 + 序号拼出业务编号。
     * @param {string} dateStr 'YYYY-MM-DD'
     * @param {number} seq 序号（1 起）
     * @returns {string} 例如 'YC-20261123-00005'
     */
    function buildNo(dateStr, seq) {
      var ds = String(dateStr === undefined || dateStr === null ? '' : dateStr);
      var n = Math.floor(Number(seq));
      if (!isFinite(n) || n < 0) n = 0;
      return NO_PREFIX + '-' + ds.replace(/-/g, '') + '-' + String(n).padStart(5, '0');
    }

    /**
     * 编号格式校验。
     * @param {*} s 任意
     * @returns {boolean} 是否匹配 /^YC-\d{8}-\d{5}$/
     */
    function isValidNo(s) {
      return typeof s === 'string' && NO_RE.test(s);
    }

    /**
     * 日期串校验：格式 + **真实日历日**往返校验。
     * 往返（new Date(s+'T00:00:00') → todayStr(d) === s）是拦 2026-02-31 / 2027-02-29
     * 这类「格式对但日期不存在」的唯一可靠手段（不同引擎对越界 ISO 的处理不一致，
     * 有的给 Invalid Date、有的滚到下月，往返校验两种都能拦住）。
     * @param {*} s 任意
     * @returns {boolean}
     */
    function isValidDate(s) {
      if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
      var d = new Date(s + 'T00:00:00');
      if (isNaN(d.getTime())) return false;
      return todayStr(d) === s;
    }

    /**
     * F5 单源发号：扫描全表既有 no，取「当日前缀」的序号 max+1，再用已用集合 while 去重兜底。
     * 刻意不设自增计数器：多一个计数器就多一个可能与真实数据漂移的真值源（设计 §1.2.4a）。
     * @param {Array<Object>} list 现有记录数组（可乱序、可含非法 no，非法项一律忽略）
     * @param {Date=} now 发号时刻，缺省当前；**决定日期段，与记录里的 date 无关**
     * @returns {string} 新编号
     */
    function nextQaNo(list, now) {
      var day = todayStr(now);
      var prefix = NO_PREFIX + '-' + day.replace(/-/g, '') + '-';
      var arr = Array.isArray(list) ? list : [];
      var used = new Set();
      var maxSeq = 0;
      for (var i = 0; i < arr.length; i++) {
        var r = arr[i];
        var no = (r && typeof r.no === 'string') ? r.no : '';
        if (!NO_RE.test(no)) continue;          /* 忽略非法格式的 no（脏数据不参与发号） */
        used.add(no);
        if (no.indexOf(prefix) === 0) {
          var seq = parseInt(no.slice(prefix.length), 10);
          if (isFinite(seq) && seq > maxSeq) maxSeq = seq;
        }
      }
      var next = maxSeq + 1;
      while (used.has(buildNo(day, next))) next++;   /* 兜底：编号被外部改过时仍不撞号 */
      return buildNo(day, next);
    }

    /** 取排序键值并统一成字符串（缺字段按空串，保证比较器全序） */
    function cellOf(rec, key) {
      var v = rec ? rec[key] : '';
      return v === undefined || v === null ? '' : String(v);
    }

    /**
     * 排序（返回新数组，绝不改入参）。
     * 默认 date DESC；二级键恒为「另一方 DESC」（设计 §3.2），保证同日记录按编号倒序、
     * 同编号（理论不存在）按日期倒序 —— 排序结果全序且稳定可预期。
     * @param {Array<Object>} list 记录数组
     * @param {string=} key 'date' | 'no'，缺省 'date'
     * @param {string=} dir 'asc' | 'desc'，缺省 'desc'
     * @returns {Array<Object>} 新数组
     */
    function sortRecords(list, key, dir) {
      var rows = Array.isArray(list) ? list.slice() : [];
      var k = key === 'no' ? 'no' : 'date';
      var d = dir === 'asc' ? 'asc' : 'desc';
      var sec = k === 'date' ? 'no' : 'date';
      rows.sort(function (a, b) {
        /* 日期串与编号串都是纯 ASCII，localeCompare 等价于字典序 */
        var c = cellOf(a, k).localeCompare(cellOf(b, k));
        if (c !== 0) return d === 'asc' ? c : -c;
        return -cellOf(a, sec).localeCompare(cellOf(b, sec));   /* 二级键恒 DESC */
      });
      return rows;
    }

    /**
     * 分页（服务端全量返回，分页纯前端做；此处只是把边界逻辑集中一处）。
     * page 越界**夹紧**到 [1, pages]，绝不返回空页；total === 0 ⇒ {rows:[], page:1, pages:1}。
     * @param {Array<Object>} list 已排序的完整记录数组
     * @param {number} page 1 起
     * @param {number} size 仅接受 10 / 100 / 1000，其余回落 DEFAULT_PAGE_SIZE
     * @returns {{rows: Array<Object>, page: number, pages: number, total: number}}
     */
    function paginate(list, page, size) {
      var all = Array.isArray(list) ? list : [];
      var total = all.length;
      var sz = PAGE_SIZES.indexOf(Number(size)) >= 0 ? Number(size) : DEFAULT_PAGE_SIZE;
      var pages = total === 0 ? 1 : Math.ceil(total / sz);
      var p = Math.floor(Number(page));
      if (!isFinite(p) || p < 1) p = 1;
      if (p > pages) p = pages;
      var start = (p - 1) * sz;
      return {
        rows: total === 0 ? [] : all.slice(start, start + sz),
        page: p,
        pages: pages,
        total: total
      };
    }

    /**
     * CSV 单元格转义：含 `"` / `,` / CR / LF ⇒ 双引号包裹，内部 `"` 转 `""`。
     * date / no 一律原样输出，不加 `="…"` 之类前缀（加前缀会让 Excel 显示出公式痕迹）。
     */
    function csvCell(v) {
      var s = v === undefined || v === null ? '' : String(v);
      if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }

    /**
     * 导出 CSV（UTF-8 BOM + CRLF，Excel 双击直开不乱码）。
     * @param {Array<Object>} records 记录数组
     * @param {Array<{key: string, label: string, get: (function(Object): *)=}>} columns 列定义
     * @returns {string} 以 '\ufeff' 开头、CRLF 换行、末尾带一个 CRLF 的 CSV 文本
     */
    function buildCsv(records, columns) {
      var cols = (Array.isArray(columns) && columns.length)
        ? columns
        : [{ key: 'date', label: '日期' }, { key: 'no', label: '编号' }];
      var lines = [];
      lines.push(cols.map(function (c) {
        return csvCell(c && c.label !== undefined && c.label !== null ? c.label : (c ? c.key : ''));
      }).join(','));
      var rows = Array.isArray(records) ? records : [];
      for (var i = 0; i < rows.length; i++) {
        var rec = rows[i] || {};
        lines.push(cols.map(function (c) {
          if (!c) return '';
          var v = typeof c.get === 'function' ? c.get(rec) : rec[c.key];
          return csvCell(v);
        }).join(','));
      }
      return '\ufeff' + lines.join('\r\n') + '\r\n';
    }

    return {
      NO_PREFIX: NO_PREFIX,
      DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE,
      PAGE_SIZES: PAGE_SIZES,
      NO_PATTERN: NO_RE,
      DATE_PATTERN: DATE_RE,
      todayStr: todayStr,
      buildNo: buildNo,
      nextQaNo: nextQaNo,
      isValidNo: isValidNo,
      isValidDate: isValidDate,
      sortRecords: sortRecords,
      paginate: paginate,
      buildCsv: buildCsv
    };
  }

  /* UMD 双形态：Node 走 CommonJS，浏览器挂 window.QA_CORE（同一份字节，两处 md5 相同） */
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    global.QA_CORE = factory();
  }
})(typeof window !== 'undefined' ? window : this);
