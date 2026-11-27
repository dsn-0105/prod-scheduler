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
     *
     * 【build .166】扩成「任意列可排」，**向后兼容**（不传 types 时行为与 .165 逐字一致）：
     *   · types 缺省 / 该 key 不在 types 里 ⇒ 仍按老的 date|no 白名单处理（不传就永远不会排错列）
     *   · 传 types = {'totalQty':'num', …} 才启用类型感知比较：
     *       num  → 数值比（脏值/非数字按空处理）
     *       date → 字符串字典序（`YYYY-MM-DD` 字典序 ≡ 时间序，无需转 Date）
     *       其它 → `localeCompare(…,'zh-CN')`（中文按拼音，与生产系统 cmpByColDef 同口径）
     *   · **空值恒沉底**：不随升降翻转。这是与生产系统的**唯一刻意差异** ——
     *     生产的订单数量列几乎不为空，而质量台账的数量列**经常整列空着**（未检测就登记），
     *     若学生产用 `Number('')=0` 参与比较，升序时一排空值会糊在表头下面，等于把「未填」误报成「最少」。
     * @param {Array<Object>} list 记录数组
     * @param {string=} key 列 key，缺省 'date'
     * @param {string=} dir 'asc' | 'desc'，缺省 'desc'
     * @param {Object<string,string>=} types key → 'num'|'date'|'text'，缺省不启用类型感知
     * @returns {Array<Object>} 新数组
     */
    function sortRecords(list, key, dir, types) {
      var rows = Array.isArray(list) ? list.slice() : [];
      var tmap = (types && typeof types === 'object') ? types : null;
      /* 关键保护：只有 types 显式声明了该 key 才认它，否则回落到老的 date/no 白名单。
         否则「传错 key」会从「静默按日期排」变成「静默按字符串排」，更难发现。 */
      var k = (tmap && typeof key === 'string' && tmap[key]) ? key : (key === 'no' ? 'no' : 'date');
      var d = dir === 'asc' ? 'asc' : 'desc';
      var sec = k === 'date' ? 'no' : (k === 'no' ? 'date' : 'no');
      var type = tmap ? tmap[k] : 'text';
      rows.sort(function (a, b) {
        var va = cellOf(a, k);
        var vb = cellOf(b, k);
        /* 空值沉底：**不乘 dir**（升序降序空值都在最后），否则用户点两次方向就看到空值跳到最前 */
        var ea = isEmptyVal(va), eb = isEmptyVal(vb);
        if (ea !== eb) return ea ? 1 : -1;
        if (!ea && !eb) {
          var c = cmpTyped(va, vb, type);
          if (c !== 0) return d === 'asc' ? c : -c;
        }
        return -cellOf(a, sec).localeCompare(cellOf(b, sec));   /* 二级键恒 DESC */
      });
      return rows;
    }

    /** 空值判定：'' / null / undefined 一律算未填（0 与 '0' 都不算空） */
    function isEmptyVal(v) {
      return v === '' || v === null || v === undefined;
    }

    /** 数值归一：非数字（含脏数据 'abc'）返回 null，由调用方按空处理 */
    function numOf(v) {
      var n = Number(v);
      return isFinite(n) ? n : null;
    }

    /**
     * 类型感知比较（返回 <0 / 0 / >0）。两侧都已非空。
     * @param {*} a 值 A
     * @param {*} b 值 B
     * @param {string} type 'num' | 'date' | 其它按文本
     * @returns {number}
     */
    function cmpTyped(a, b, type) {
      if (type === 'num') {
        var na = numOf(a), nb = numOf(b);
        if (na === null && nb === null) return 0;
        if (na === null) return 1;                 /* 脏值沉底 */
        if (nb === null) return -1;
        return na - nb;
      }
      var sa = String(a), sb = String(b);
      if (type === 'date') return sa < sb ? -1 : (sa > sb ? 1 : 0);
      return sa.localeCompare(sb, 'zh-CN');
    }

    /* ---------- 日期辅助（日期列快捷筛选必需；口径与生产系统 getWeekStart/addMonthsStr 一致） ---------- */

    /** 周一为一周起点（周日算第 7 天）→ 'YYYY-MM-DD' */
    function weekStartOf(dateStr) {
      var d = new Date(String(dateStr) + 'T00:00:00');
      if (isNaN(d.getTime())) return '';
      var day = d.getDay() || 7;
      d.setDate(d.getDate() - day + 1);
      return todayStr(d);
    }

    /** 日期加减自然月（目标月天数不足时钳到月末）→ 'YYYY-MM-DD' */
    function addMonthsStr(dateStr, n) {
      var d = new Date(String(dateStr) + 'T00:00:00');
      if (isNaN(d.getTime())) return String(dateStr);
      var y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
      var last = new Date(y, m + n + 1, 0).getDate();
      var r = new Date(y, m + n, Math.min(day, last));
      return todayStr(r);
    }

    /* ---------- 筛选引擎（纯函数；DOM 层只负责收集 f，判定全在这里） ---------- */

    /** 各列可用的筛选模式（UI 下拉与引擎**同一份**，禁止 qa-app 再写一份字面量） */
    var FILT_MODES_TEXT = [
      ['contains', '包含'], ['not_contains', '不包含'], ['eq', '等于'], ['neq', '不等于'],
      ['startswith', '以…开始'], ['endswith', '以…结束'], ['is_empty', '为空'], ['not_empty', '不为空']
    ];
    /* 【build .166】数字列 = 生产 4 模式（≥ ≤ = ≠）+ 「为空/不为空」。
       后两者是**对生产的有意扩展**（用户 Q2A 拍板）：台账数量列经常整列空着，
       没有它就只能靠肉眼翻页去找"还没填检测数"的记录。 */
    var FILT_MODES_NUM = [
      ['gte', '大于等于'], ['lte', '小于等于'], ['eq', '等于'], ['neq', '不等于'],
      ['is_empty', '为空'], ['not_empty', '不为空']
    ];
    /** 日期列 8 快捷模式（与生产 ENH_DATE_MODES_LIST 逐条一致） */
    var FILT_MODES_DATE = [
      ['today', '今天'], ['this_week', '本周'], ['this_month', '本月'], ['last_month', '上月'],
      ['last_1m', '过去一个月'], ['last_3m', '过去三个月'], ['range', '从…到…'], ['eq', '等于']
    ];
    /** 模式 → 中文名（面板、筛选条 chips 共用；与生产 MODE_NAME 同口径） */
    var FILT_MODE_NAME = {
      contains: '包含', not_contains: '不包含', eq: '=', neq: '≠', startswith: '以…开始', endswith: '以…结束',
      is_empty: '为空', not_empty: '不为空', gte: '≥', lte: '≤',
      today: '今天', this_week: '本周', this_month: '本月', last_month: '上月',
      last_1m: '过去一个月', last_3m: '过去三个月', range: '从…到…'
    };

    /** 按列类型取模式清单 */
    function filtModesOf(type) {
      if (type === 'num') return FILT_MODES_NUM;
      if (type === 'date') return FILT_MODES_DATE;
      return FILT_MODES_TEXT;
    }

    /** 该模式是否需要用户输入值（false ⇒ 选中即隐藏输入框：为空/不为空/日期快捷模式） */
    function modeNeedsVal(mode) {
      return !(mode === 'is_empty' || mode === 'not_empty'
        || mode === 'today' || mode === 'this_week' || mode === 'this_month'
        || mode === 'last_month' || mode === 'last_1m' || mode === 'last_3m' || mode === 'range');
    }

    /**
     * 单个筛选条件是否「有效」（有筛选意图）。
     * 与生产 filterRows 的 hasVals/hasVal/valFreeMode 三段判据同构。
     *
     * ⚠ `range` 必须**先**判：它的取值在 `from`/`to` 而不是 `val`，
     * 若落到下面 `!modeNeedsVal(mode)` 那一支，会被当成"无需值的自由模式"直接判有效
     * ⇒ 用户点了确定、chips 出现、漏斗点亮，但表格纹丝不动（空区间放行所有行）。
     * 该缺陷由 tests/qa.ledger-filter-sort.independent.test.js §B4 首次抓到。
     * @param {object} f {mode, val, from, to}
     * @returns {boolean}
     */
    function filtActive(f) {
      if (!f || !f.mode) return false;
      if (f.mode === 'range') return !!(f.from && f.to);
      if (!modeNeedsVal(f.mode)) return true;
      return f.val !== '' && f.val !== null && f.val !== undefined;
    }

    /**
     * 单列判定。
     * @param {*} raw 该列在记录里的原始值
     * @param {string} type 列类型 'num' | 'date' | 其它文本
     * @param {object} f 筛选条件 {mode, val, from, to}
     * @param {string=} today 今天（YYYY-MM-DD），缺省取本地今天；测试可注入
     * @returns {boolean} 命中为 true
     */
    function matchFilter(raw, type, f, today) {
      if (!filtActive(f)) return true;
      var empty = isEmptyVal(raw) || (type === 'num' && numOf(raw) === null);
      /* 为空/不为空：用**原始值**判，不走 String(null)（否则 'null' 会被当成有值） */
      if (f.mode === 'is_empty') return empty;
      if (f.mode === 'not_empty') return !empty;

      if (type === 'num') {
        if (empty) return false;
        var nv = numOf(raw), fv = numOf(f.val);
        if (fv === null) return true;                 /* 输入框空着 ⇒ 不构成约束（生产同款宽松） */
        if (f.mode === 'gte') return nv >= fv;
        if (f.mode === 'lte') return nv <= fv;
        if (f.mode === 'eq') return nv === fv;
        if (f.mode === 'neq') return nv !== fv;
        return true;
      }

      if (type === 'date') {
        if (empty) return false;
        var dv = String(raw);
        if (f.mode === 'range') {
          if (!f.from || !f.to) return true;
          return dv >= f.from && dv <= f.to;
        }
        if (f.mode === 'eq') return f.val ? dv === String(f.val) : true;
        var t = today || todayStr();
        if (f.mode === 'today') return dv === t;
        if (f.mode === 'this_week') return weekStartOf(dv) === weekStartOf(t);
        if (f.mode === 'this_month') return dv.slice(0, 7) === t.slice(0, 7);
        if (f.mode === 'last_month') return dv.slice(0, 7) === addMonthsStr(t, -1).slice(0, 7);
        if (f.mode === 'last_1m') return dv >= addMonthsStr(t, -1);
        if (f.mode === 'last_3m') return dv >= addMonthsStr(t, -3);
        return true;
      }

      /* 文本 8 模式 */
      if (empty) return false;
      var sv = String(raw), q = String(f.val === undefined || f.val === null ? '' : f.val);
      if (f.mode === 'contains') return sv.indexOf(q) >= 0;
      if (f.mode === 'not_contains') return sv.indexOf(q) < 0;
      if (f.mode === 'eq') return sv === q;
      if (f.mode === 'neq') return sv !== q;
      if (f.mode === 'startswith') return sv.indexOf(q) === 0;
      if (f.mode === 'endswith') return q.length <= sv.length && sv.slice(sv.length - q.length) === q;
      return true;
    }

    /**
     * 多列 AND 筛选。
     * @param {Array<Object>} list 记录数组
     * @param {Array<Object>} schema 列定义（需含 key / type）
     * @param {Object<string,object>} filters key → {mode,val,from,to}
     * @param {string=} today 今天，缺省本地今天
     * @returns {Array<Object>} 新数组（无有效筛选时返回原数组的浅拷贝）
     */
    function applyFilters(list, schema, filters, today) {
      var rows = Array.isArray(list) ? list : [];
      var cols = Array.isArray(schema) ? schema : [];
      var fs = (filters && typeof filters === 'object') ? filters : {};
      var keys = Object.keys(fs).filter(function (k) { return filtActive(fs[k]); });
      if (!keys.length) return rows.slice();
      return rows.filter(function (r) {
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var col = null;
          for (var j = 0; j < cols.length; j++) { if (cols[j].key === k) { col = cols[j]; break; } }
          if (!col) continue;                     /* 列定义里没有的 key ⇒ 忽略（不让脏筛选卡死整表） */
          var raw = r ? r[k] : '';
          if (!matchFilter(raw, col.type, fs[k], today)) return false;
        }
        return true;
      });
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
      buildCsv: buildCsv,
      /* 【build .166】排序/筛选扩展（纯函数，可脱离 DOM 单测） */
      isEmptyVal: isEmptyVal,
      numOf: numOf,
      cmpTyped: cmpTyped,
      weekStartOf: weekStartOf,
      addMonthsStr: addMonthsStr,
      FILT_MODES_TEXT: FILT_MODES_TEXT,
      FILT_MODES_NUM: FILT_MODES_NUM,
      FILT_MODES_DATE: FILT_MODES_DATE,
      FILT_MODE_NAME: FILT_MODE_NAME,
      filtModesOf: filtModesOf,
      modeNeedsVal: modeNeedsVal,
      filtActive: filtActive,
      matchFilter: matchFilter,
      applyFilters: applyFilters
    };
  }

  /* UMD 双形态：Node 走 CommonJS，浏览器挂 window.QA_CORE（同一份字节，两处 md5 相同） */
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    global.QA_CORE = factory();
  }
})(typeof window !== 'undefined' ? window : this);
