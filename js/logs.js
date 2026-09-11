/* 2026-09-01 架构拆分批次2（build .102）：操作日志模块（logs 变量/logOp/renderLogs/clearLogs 从 index.html 提取）
   依赖全局：save/confirm/renderContent/渲染引擎（applyTable/slicePaged/thCol 等，留在 index.html）
   logOp 被全系统 75 处调用（onclick 运行时解析，全局函数可见） */
let logs=[];
function logOp(action,target,detail,field,oldv,newv){
  var entry={time:new Date().toLocaleString('zh-CN',{hour12:false}),action:action,target:target,detail:detail,
    field:field||'', oldv:(oldv===undefined?'':oldv), newv:(newv===undefined?'':newv)};
  logs.unshift(entry);
  if(logs.length>500)logs=logs.slice(0,500);
  /* 【P1】.124：silent=true —— 日志是 best-effort 副作用，不能因为 logs 表的乐观锁 409
     让用户看到「本次保存未生效」的假告警（他的主业务其实已经成功）。
     silent 下 DB.set 的 409 分支只 pullAll 刷新 revs（下次写自动恢复）而不弹窗。 */
  save('logs',logs,true);
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
      +thCol('logs',TBL_SCHEMAS.logs[1],'width:60px')
      +thCol('logs',TBL_SCHEMAS.logs[2],'width:120px')
      +thCol('logs',TBL_SCHEMAS.logs[3],'width:130px')
      +thCol('logs',TBL_SCHEMAS.logs[4])
      +'</tr></thead><tbody>';
    if(shownLogs.length===0){html+=noMatchRow('logs',5);}
    shownLogs.forEach(l=>{
      const cls=ACTION_CLS[l.action]||'tag-gray';
      html+='<tr><td data-key="time" style="font-size:12px;color:var(--muted);white-space:nowrap">'+esc(l.time)+'</td>'
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
