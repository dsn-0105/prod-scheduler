/* 2026-09-01 架构拆分批次4：排产域核心查询/计算函数（ppItems/ppSteps/tplOf/stepsDefOf/pp*系列/prNextId/ppReportsOf 从 index.html 提取）
   纯查询函数（无 DOM/无 save/无副作用），依赖全局：deliveries/productionPlans/productionReports/num
   被排产/交付/报工模块大量调用（运行时全局解析） */
function ppItems(p){ return (Array.isArray(p.items)&&p.items.length)?p.items:[{productId:p.productId||'',productName:p.productName||'',spec:p.spec||'',model:p.model||'',unit:p.unit||'',planQty:num(p.planQty),doneQty:num(p.doneQty),steps:null}]; }
function ppSteps(it){
  if(it&&it.steps)return it.steps;
  const s={assembly:{plan:0,done:0},instant:{plan:0,done:0},delay:{plan:0,done:0},innerPack:{plan:0,done:0},aging:{plan:0,done:0},inbound:0};
  if(it){
    s.assembly.plan=num(it.assemblyPlan);s.innerPack.plan=num(it.innerPackPlan);
    s.assembly.done=num(it.assemblyDone);s.innerPack.done=num(it.innerPackDone);
    s.aging.plan=num(it.testAgingPlan);s.aging.done=num(it.testAgingDone);
    s.inbound=num(it.finInbound);
  }
  return s;
}
/* 工序定义（含 label/plan/mandatory）：行快照 stepsDef > 排产单模板 > 默认模板 */
function tplOf(id){
  if(!processTemplates||!processTemplates.length)return null;
  return processTemplates.find(t=>t.id===id)||null;
}
function stepsDefOf(p,it){
  if(it&&Array.isArray(it.stepsDef)&&it.stepsDef.length)return it.stepsDef;
  if(p&&p.processTplId){const t=tplOf(p.processTplId);if(t&&Array.isArray(t.steps)&&t.steps.length)return t.steps;}
  return DEFAULT_TPL_STEPS;
}
/* 确保 steps 包含工序定义全部键（缺失补 0；老键数据平移：aging←testAging/inbound←finInbound） */
function ppEnsureSteps(it,def){
  if(!it)return;
  const st=it.steps||(it.steps={});
  (def||DEFAULT_TPL_STEPS).forEach(x=>{
    if(st[x.key]===undefined){
      const lv=PP_LEGACY_MAP[x.key]?st[PP_LEGACY_MAP[x.key]]:undefined;
      if(lv!==undefined)st[x.key]=(typeof lv==='object')?{plan:num(lv.plan),done:num(lv.done)}:num(lv);
      else st[x.key]=x.plan?{plan:0,done:0}:0;
    }
  });
  return st;
}
function ppStepRaw(st,key){
  if(st[key]!==undefined)return st[key];
  if(PP_LEGACY_MAP[key]&&st[PP_LEGACY_MAP[key]]!==undefined)return st[PP_LEGACY_MAP[key]];
  return undefined;
}
function ppStepDone(it,key){ const v=ppStepRaw(ppSteps(it),key); return num(typeof v==='object'?v.done:v); }
function ppStepPlan(it,key){ const v=ppStepRaw(ppSteps(it),key); return num(typeof v==='object'?v.plan:v); }
function ppDoneOf(it){ return num(it&&it.doneQty!=null?it.doneQty:ppStepDone(it,'inbound')); }
function ppPlanOf(it){ return num(it&&it.planQty!=null?it.planQty:0); }
function ppProgress(p){ let t=0,d=0; ppItems(p).forEach(it=>{t+=ppPlanOf(it);d+=ppDoneOf(it);}); return t>0?Math.round(d/t*100):0; }
function ppStatusCls(st){ return st==='已完成'?'tag-green':st==='生产中'?'tag-blue':st==='已取消'?'tag-gray':'tag-amber'; }
function ppWeekRange(d){
  const date=new Date(d);
  const day=date.getDay()||7;
  date.setDate(date.getDate()-day+1);
  const start=fmtDate(date);
  date.setDate(date.getDate()+6);
  return [start,fmtDate(date)];
}
/* 需求 2026-08-24.7：同一交付计划 + 同一产品，已下推的排产数量总和（编辑时 excludeIdx 排除自身） */
function ppPlannedOf(deliveryIdx,productId,excludeIdx){
  if(deliveryIdx==null)return 0;
  let s=0;
  productionPlans.forEach((p,idx)=>{
    if(idx===excludeIdx)return;
    if(p.deliveryIdx!==deliveryIdx)return;
    if(p.status==='已取消')return;   /* 2026-08-24.16：已取消排产单不计入已排产（释放额度） */
    ppItems(p).forEach(it=>{ if((it.productId||'')===(productId||'')) s+=num(it.planQty); });
  });
  return s;
}
/* 交付计划某产品行的本批计划（总计划数）；查不到返回 null（独立单不限制） */
function ppTotalOf(deliveryIdx,productId){
  if(deliveryIdx==null)return null;
  const d=deliveries[deliveryIdx];
  if(!d)return null;
  const it=deliveryItems(d).find(x=>(x.productId||'')===(productId||''));
  return it?num(it.planQty):null;
}
/* 2026-08-25.24：行级聚合（同产品多行明细时按交付计划行区分，修复下推数量被取首行/聚合的错误）。
   排产单行带 dlLine（交付计划 items 原索引）→ 按行计算；无 dlLine（存量排产单）→ 回退产品级聚合，行为不变 */
function ppTotalOfLine(deliveryIdx,dlLine,productId){
  if(deliveryIdx==null)return null;
  if(dlLine!=null&&deliveries[deliveryIdx]){
    const lineItems=deliveryItems(deliveries[deliveryIdx]);
    if(lineItems[dlLine]!=null)return num(lineItems[dlLine].planQty);
  }
  return ppTotalOf(deliveryIdx,productId);
}
function ppPlannedOfLine(deliveryIdx,dlLine,productId,excludeIdx){
  if(deliveryIdx==null)return 0;
  if(dlLine==null)return ppPlannedOf(deliveryIdx,productId,excludeIdx);
  /* 同单存在无 dlLine 的存量行（老格式）时无法按行区分 → 回退产品级聚合 */
  const hasLegacy=productionPlans.some((p,idx)=>{
    if(idx===excludeIdx||p.deliveryIdx!==deliveryIdx||p.status==='已取消')return false;
    return ppItems(p).some(it=>it.dlLine==null);
  });
  if(hasLegacy)return ppPlannedOf(deliveryIdx,productId,excludeIdx);
  let s=0;
  productionPlans.forEach((p,idx)=>{
    if(idx===excludeIdx||p.deliveryIdx!==deliveryIdx||p.status==='已取消')return;
    ppItems(p).forEach(it=>{ if(it.dlLine===dlLine)s+=num(it.planQty); });
  });
  return s;
}
/* 交付计划已下推排产数量合计（build 2026-08-24.17）：Σ 名下排产单 items.planQty（排除已取消，同状态口径） */
function ppPlannedTotal(deliveryIdx){
  if(deliveryIdx==null)return 0;
  let planned=0;
  productionPlans.forEach(p=>{
    if(p.deliveryIdx!==deliveryIdx)return;
    if(p.status==='已取消')return;   /* 取消=释放额度，不计入已排产 */
    ppItems(p).forEach(it=>{planned+=num(it.planQty);});
  });
  return planned;
}
/* 交付计划排产状态（build 2026-08-24.16；.78 改名 未排产→未下推/部分排产→部分下推/全部排产→全部下推）：实时计算不可编辑。
   口径：已排产=名下全部排产单（排除已取消，同 ppPlannedOf）items.planQty 合计；总计划=明细行 planQty 合计；
   独立单（deliveryIdx=null）不参与。删除/取消排产单、改排产数量、改交付计划 planQty 均自动反映。 */
const PP_DL_STATUS_W={未下推:0,部分下推:1,全部下推:2};
function ppDeliveryStatus(deliveryIdx){
  const d=deliveries[deliveryIdx];
  if(!d)return '未下推';
  let total=0;
  deliveryItems(d).forEach(it=>{total+=num(it.planQty);});
  if(total<=0)return '未下推';
  const planned=ppPlannedTotal(deliveryIdx);
  if(planned<=0)return '未下推';
  return planned>=total?'全部下推':'部分下推';
}
function ppDlStatusTag(st){ return st==='全部下推'?'tag-green':st==='部分下推'?'tag-blue':'tag-amber'; }
/* ================================================================
   报工明细（productionReports，build 2026-08-24.8）：
   一次报工=一条记录；行内展开（▶）+ 弹窗查看；只读展示
================================================================ */
function prNextId(){
  const today=todayStr().replace(/-/g,'');
  const re=new RegExp('^REP-'+today+'-(\\d+)$');
  let max=0;
  productionReports.forEach(r=>{
    const m=String(r.id||'').match(re);
    if(m)max=Math.max(max,parseInt(m[1],10));
  });
  return 'REP-'+today+'-'+String(max+1).padStart(3,'0');
}
/* 某排产单的报工明细（按时间倒序） */
function ppReportsOf(planId){
  return productionReports.filter(r=>r.planId===planId).sort((a,b)=>((a.createdAt||'')<(b.createdAt||'')?1:-1));
}
