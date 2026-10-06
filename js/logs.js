/* 2026-09-01 架构拆分批次2（build .102）：操作日志模块（logs 变量/logOp/renderLogs/clearLogs 从 index.html 提取）
   依赖全局：save/confirm/renderContent/渲染引擎（applyTable/slicePaged/thCol 等，留在 index.html）
   logOp 被全系统 75 处调用（onclick 运行时解析，全局函数可见）

   【build 2026-09-11.125 · C 项】日志补「操作者」+ 固定时间格式，并把「造条目」拆成纯函数：
     · time 由 toLocaleString('zh-CN') 改为固定 'YYYY-MM-DD HH:mm:ss'（本地时区）——可排序、跨浏览器一致；
     · 条目新增 user = currentUser.name || currentUser.username || ''（历史无该字段的记录显示「—」）；
     · logOp 的**签名与外部语义一律不变**（造条目 → unshift → 截断 500 → silent 落盘）；
     · 新增 makeLogEntry()（只造条目，不写盘、不入内存）与 pushLogEntry()（只入内存，不写盘），
       供「多表原子写」路径复用：调用方把日志条目先入内存，再把 logs 并入**同一次** DB.tx
       （.125：bulkDelete / delProdPlan / confirmClear / restoreBackup 四处多表写点），
       从而不再出现「N 条日志 = N 次独立 save」的分步写。

   【build 2026-10-06.135】logOp 落盘改为**同段合并**（微任务延迟，scheduleLogFlush）：
     原来每次 logOp 都整表覆盖写 logs，同一同步段内两次调用必有一次吃乐观锁 409 且被 silent 静默吞掉
     （线上实证丢条 + journal 累计 195 次冲突）。修法详见 logOp 上方大段注释——签名与外部语义不变。 */
let logs=[];
/* 固定格式 'YYYY-MM-DD HH:mm:ss'（本地时区）；d 缺省 = now */
function logTimeStr(d){
  var t=d||new Date();
  var p=function(n){return (n<10?'0':'')+n;};
  return t.getFullYear()+'-'+p(t.getMonth()+1)+'-'+p(t.getDate())+' '+p(t.getHours())+':'+p(t.getMinutes())+':'+p(t.getSeconds());
}
/* 操作者：姓名优先，回退工号/用户名；未登录/系统动作 → ''（历史记录渲染为「—」） */
function logUserName(){
  if(!currentUser)return '';
  return currentUser.name||currentUser.username||'';
}
/* 纯构造：只造条目，不写盘、不入内存（供事务化路径把 logs 并入同一次 DB.tx） */
function makeLogEntry(action,target,detail,field,oldv,newv){
  return {time:logTimeStr(new Date()),action:action,target:target,user:logUserName(),detail:detail,
    field:field||'', oldv:(oldv===undefined?'':oldv), newv:(newv===undefined?'':newv)};
}
/* 纯入内存：unshift + 截断 500，不写盘 */
function pushLogEntry(entry){
  logs.unshift(entry);
  if(logs.length>500)logs=logs.slice(0,500);
  return entry;
}
/* 【build 2026-10-06.135】同一次同步执行内的多次 logOp 合并为**一次**落盘（微任务延迟）。
   事故背景（线上实测坐实）：logOp 每次都 `save('logs',logs,true)` —— 对共享 logs 表**整表覆盖写**。
   同一同步段内两次调用 → 第二条携带**过期 rev** → 服务端乐观锁 409 冲突拦截 → 因 silent=true
   被**静默吞掉**（不弹窗、不重试）→ 该条审计记录**永久丢失**。
   实证：2026-10-06 12:53:47 `[冲突拦截] key=logs user=admin expectedRev=0 curRev=1`；
   被吞掉的正是「存量交付计划回填交付计划编号 62 条」那条（**回填本身成功、业务数据无损，仅日志缺条**）：
   `migrateDeliveryPlanNoField()` 与 `migrateDeliveryPlanNo()` 在同一次 initApp 内各 logOp 一次即触发。
   journal 保留期内 logs 表冲突累计 **195 次**（orders 1 / productionPlans 8，后两者非静默、有提示）。
   修法：落盘推迟到一个微任务；期间到达的 logOp 只入内存，到点用**当时最新**的 logs 与 rev 落盘一次。
   口径不变（重要）：签名、条目结构、logUserName、截断 500、silent 语义**一律不动**，
   仅把「何时落盘」由「每次同步调用」改为「同段末合并一次」。
   安全性：`.125` 四个事务写入点（bulkDelete / delProdPlan / confirmClear / restoreBackup）走的是
   `pushLogEntry` + 单次 `DB.tx([...,{key:'logs',value:logs}])`，**不调 logOp** → 不经本路径、不受影响。
   已知残留（本轮不处理）：两个不同用户浏览器**跨进程**同时写 logs，仍可能丢一条。 */
let logFlushPending=false;
function scheduleLogFlush(){
  if(logFlushPending)return;
  logFlushPending=true;
  Promise.resolve().then(function(){
    logFlushPending=false;
    save('logs',logs,true);   /* 取「当时最新」的 logs 与 rev */
  });
}
function logOp(action,target,detail,field,oldv,newv){
  pushLogEntry(makeLogEntry(action,target,detail,field,oldv,newv));
  /* 【P1】.124：silent=true —— 日志是 best-effort 副作用，不能因为 logs 表的乐观锁 409
     让用户看到「本次保存未生效」的假告警（他的主业务其实已经成功）。
     silent 下 DB.set 的 409 分支只 pullAll 刷新 revs（下次写自动恢复）而不弹窗。 */
  scheduleLogFlush();
}
/* 【P1】.124：清空日志为 admin 专属（服务端会拒绝非 admin 的整表清空/缩减）。
   前端同步收敛：非 admin 不渲染「清空日志」按钮，避免点了才吃 403。 */
function canClearLogs(){return !!(currentUser&&currentUser.role==='admin');}
function renderLogs(){
  const ACTION_CLS={'新增':'tag-green','编辑':'tag-blue','删除':'tag-red','导入':'tag-amber','导出':'','清空':'tag-red','字段设置':''};
  let html='<div class="card"><div class="card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;color:var(--primary)"><path d="M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>操作日志 <span class="desc">记录关键操作 · 最多保留 500 条</span> '+(canClearLogs()?'<button class="btn btn-sm btn-danger" style="margin-left:auto" onclick="clearLogs()">清空日志</button>':'<span style="margin-left:auto"></span>')+'</div>';
  if(logs.length===0){
    html+='<div class="empty">暂无操作记录</div>';
  }else{
    TBL_SCHEMAS.logs=[
      {key:'time',label:'时间',type:'text'},
      {key:'user',label:'操作者',type:'text',select:true},   /* .125：新增「操作者」列（历史无 user → 渲染「—」） */
      {key:'action',label:'操作',type:'text',select:true},
      {key:'target',label:'表单',type:'text',select:true},
      {key:'field',label:'字段',type:'text',select:true},
      {key:'detail',label:'详情(旧→新)',type:'text'}
    ];
    TBL_ROWS.logs=logs;
    let shownLogs=applyTable('logs',logs);
    /* 2026-08-25.68：金蝶式分页（单行模型直接切行；日志无操作栏，分页栏放表格上方右对齐） */
    if(PAGED_FORMS.logs&&shownLogs.length>0)shownLogs=slicePaged('logs',shownLogs,pageSizeOf('logs')).rows;
    html+=filterBar('logs');
    html+='<div class="bulk-bar" style="margin:8px 0 6px">'+pagerHtml('logs')+'</div>';
    html+='<div class="table-wrap"><table><thead><tr>'
      +thCol('logs',TBL_SCHEMAS.logs[0],'min-width:140px')
      +thCol('logs',TBL_SCHEMAS.logs[1],'width:90px')
      +thCol('logs',TBL_SCHEMAS.logs[2],'width:60px')
      +thCol('logs',TBL_SCHEMAS.logs[3],'width:120px')
      +thCol('logs',TBL_SCHEMAS.logs[4],'width:130px')
      +thCol('logs',TBL_SCHEMAS.logs[5])
      +'</tr></thead><tbody>';
    if(shownLogs.length===0){html+=noMatchRow('logs',6);}
    shownLogs.forEach(l=>{
      const cls=ACTION_CLS[l.action]||'tag-gray';
      html+='<tr><td data-key="time" style="font-size:12px;color:var(--muted);white-space:nowrap">'+esc(l.time)+'</td>'
        +'<td data-key="user" style="font-size:12px;color:var(--muted);white-space:nowrap">'+(l.user?esc(l.user):'—')+'</td>'
        +'<td data-key="action"><span class="tag '+cls+'">'+esc(l.action)+'</span></td>'
        +'<td data-key="target">'+esc(l.target)+'</td>'
        +'<td data-key="field" style="font-size:13px;color:var(--primary);font-weight:600">'+(l.field?esc(l.field):'<span style="color:var(--muted);font-weight:400">—</span>')+'</td>'
        +'<td data-key="detail" style="font-size:13px">'+esc(l.detail)+'</td></tr>';
    });
    html+='</tbody></table></div>';
  }
  html+='</div>';
  return html;
}
function clearLogs(){
  if(!canClearLogs()){alert('仅管理员可清空操作日志');return;}   /* 【P1】与服务端判定一致，前端先拦 */
  if(!confirm('确认清空所有操作日志？此操作不可恢复。'))return;
  logs=[];
  save('logs',logs);
  logOp('清空','操作日志','清空全部日志');
  renderContent();
}
