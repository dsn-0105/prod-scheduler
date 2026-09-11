'use strict';
/* ================================================================
   tests/harness/recorder.js —— 写集记录器（save / DB.set / DB.tx）
   ================================================================
   设计依据：docs/P1地基轮设计-2026-09-11.md §2.2（文件 #9）、§6.2

   作用：把生产数据层的三个写入口替换为「记录调用 + 返回可控结果」的桩，
   使测试能断言：
     - 写了哪些表（keys）
     - 什么顺序（sequence）
     - 一次业务动作发起了几次事务（txCount）—— 即 invariants「write_set 恰好一个 /api/tx」
     - 成功 / 失败路径（可注入失败，验证调用方回滚与提示分支）

   记录条目结构（calls[i]）：
     { seq, op:'save'|'set'|'tx', key?, keys?, value?, ops?, silent?, result, error? }

   注意（边界）：
     - 记录器不模拟网络、不模拟乐观锁；它只替代「最终写入口」。
     - 被替换的是生产 index.html 的全局 `save` 与 `DB.set` / `DB.tx`
       （见 sandbox.js#installRecorder），因此**不覆盖** save() 内的自动备份分支
       （该分支仅在本地模式且 bootDone 为真时触发，属渲染/副作用域，不在测试范围）。
   ================================================================ */

const WRITE_OPS = ['save', 'set', 'tx'];

/**
 * 创建写集记录器。
 * @param {Object} [opts]
 *   - store：共享的内存「服务器」状态对象（key → value）；不传则新建
 *   - results：{save:bool, set:bool, tx:bool} 各写入口的默认返回结果（save 返回 v，忽略该值）
 *   - silent：占位保留（记录条目会回填调用方传入的 silent）
 * @returns {Object} recorder
 */
function createRecorder(opts) {
  const options = opts || {};
  const store = options.store || {};
  const calls = [];

  /** 各写入口的「一次性」与「持续性」失败配置 */
  const state = {
    results: Object.assign({ save: true, set: true, tx: true }, options.results || {}),
    failNext: {}, // op → {message} / Error，仅生效一次
    failAlways: {}, // op → {message} / Error
    lastError: null,
  };

  function normalizeError(e) {
    if (e instanceof Error) return e;
    return new Error(typeof e === 'string' ? e : 'recorder injected failure');
  }

  /** 返回该 op 当前应返回的结果；若配置了失败则返回 {failed:true, error} */
  function resolve(op) {
    if (state.failAlways[op] !== undefined) {
      const err = normalizeError(state.failAlways[op]);
      state.lastError = err;
      return { failed: true, error: err, result: false };
    }
    if (state.failNext[op] !== undefined) {
      const raw = state.failNext[op];
      delete state.failNext[op];
      const err = normalizeError(raw);
      state.lastError = err;
      return { failed: true, error: err, result: false };
    }
    return { failed: false, error: null, result: state.results[op] };
  }

  function push(entry) {
    entry.seq = calls.length;
    calls.push(entry);
    return entry;
  }

  /* ---------------- 三个写入口 ---------------- */

  /** 对应生产 save(k,v)：同步、返回 v；记录一次写。 */
  function save(k, v) {
    const r = resolve('save');
    const entry = push({
      op: 'save',
      key: k,
      keys: [k],
      value: v,
      silent: undefined,
      result: r.failed ? false : v,
      error: r.error ? r.error.message : null,
    });
    if (!r.failed) store[k] = v;
    return r.failed ? v : v; // 生产 save 恒返回 v（fire-and-forget），保持签名兼容
  }

  /** 对应生产 DB.set(k,v,silent)：async、返回 boolean。 */
  async function dbSet(k, v, silent) {
    const r = resolve('set');
    push({
      op: 'set',
      key: k,
      keys: [k],
      value: v,
      silent: silent,
      result: r.result,
      error: r.error ? r.error.message : null,
    });
    if (!r.failed) store[k] = v;
    return r.result;
  }

  /** 对应生产 DB.tx(ops,silent)：async、返回 boolean。整批语义——失败则一字不写。 */
  async function dbTx(ops, silent) {
    const list = Array.isArray(ops) ? ops : [];
    const r = resolve('tx');
    push({
      op: 'tx',
      key: null,
      keys: list.map(function (o) {
        return o && o.key;
      }),
      ops: list.slice(),
      silent: silent,
      result: r.result,
      error: r.error ? r.error.message : null,
    });
    if (!r.failed) {
      list.forEach(function (o) {
        if (o && o.key !== undefined) store[o.key] = o.value;
      });
    }
    return r.result;
  }

  /* ---------------- 断言辅助 ---------------- */

  const api = {
    calls: calls,
    store: store,

    /* 原始三个写入口（供 sandbox.installRecorder 注入） */
    save: save,
    dbSet: dbSet,
    dbTx: dbTx,

    /** 全部写调用（按时间顺序） */
    all: function () {
      return calls.slice();
    },

    /** 按 op 过滤：'save' | 'set' | 'tx' */
    of: function (op) {
      return calls.filter(function (c) {
        return c.op === op;
      });
    },

    /** tx 调用次数（invariant：一次多表业务动作应恰好 1 次） */
    txCount: function () {
      return api.of('tx').length;
    },

    /** 全部写入口的次数（save+set+tx） */
    writeCount: function () {
      return calls.length;
    },

    /** 写序：扁平化的「key 序列」（tx 展开为其 ops 的 keys），即实际写集顺序 */
    writeOrder: function () {
      const out = [];
      calls.forEach(function (c) {
        (c.keys || []).forEach(function (k) {
          out.push(k);
        });
      });
      return out;
    },

    /** 某表被写了几次 */
    countOf: function (key) {
      let n = 0;
      calls.forEach(function (c) {
        (c.keys || []).forEach(function (k) {
          if (k === key) n++;
        });
      });
      return n;
    },

    /** 最后一次 tx 的 ops（key → value 的 Map 由 store 提供） */
    lastTx: function () {
      const list = api.of('tx');
      return list.length ? list[list.length - 1] : null;
    },

    /** 最后一次写入的 store 快照（浅拷贝） */
    snapshot: function () {
      const out = {};
      Object.keys(store).forEach(function (k) {
        out[k] = store[k];
      });
      return out;
    },

    /** 设置写入口的默认返回结果：setResult('tx', false) */
    setResult: function (op, value) {
      if (WRITE_OPS.indexOf(op) < 0) throw new Error('[recorder] 未知写入口: ' + op);
      state.results[op] = value;
    },

    /** 下一次该写入口失败（一次性）：failNext('tx', 'disk full') */
    failNext: function (op, err) {
      if (WRITE_OPS.indexOf(op) < 0) throw new Error('[recorder] 未知写入口: ' + op);
      state.failNext[op] = err instanceof Error ? err : String(err == null ? 'injected failure' : err);
    },

    /** 该写入口此后一直失败：failAlways('tx', new Error('boom')) */
    failAlways: function (op, err) {
      if (WRITE_OPS.indexOf(op) < 0) throw new Error('[recorder] 未知写入口: ' + op);
      state.failAlways[op] = err instanceof Error ? err : String(err == null ? 'injected failure' : err);
    },

    /** 清除失败配置 */
    clearFailures: function () {
      state.failNext = {};
      state.failAlways = {};
      state.lastError = null;
    },

    /** 清空调用记录（不动 store） */
    reset: function () {
      calls.length = 0;
      state.lastError = null;
    },

    /** 同时清空记录与 store */
    resetAll: function () {
      api.reset();
      Object.keys(store).forEach(function (k) {
        delete store[k];
      });
    },

    /** 最后一次注入的错误（便于断言失败原因被记录） */
    lastError: function () {
      return state.lastError;
    },
  };

  return api;
}

module.exports = { createRecorder: createRecorder, WRITE_OPS: WRITE_OPS };
