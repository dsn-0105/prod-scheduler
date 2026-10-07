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
/* 2026-10-07.137：排产单 → 交付计划索引的**唯一解析入口**（事故根因 R1 防复发）。
   背景：deliveries 删除只做 splice，全工程无任何地方重排 productionPlans[].deliveryIdx
   → 删除一张交付计划后，后续排产单 deliveryIdx 集体前移，指向别人的交付计划（进而串料）。
   口径：优先用稳定外键 deliveryPlanNo 在 deliveries 中按编号查索引（抗索引漂移）；
   查不到（存量无外键 / 目标计划已删）→ 回退存储索引 deliveryIdx（越界返回 null）。
   独立单（deliveryIdx=null，复制单）恒返回 null —— 不占交付计划额度，与改造前逐字一致。 */
function ppDlIdxOf(p){
  if(!p||p.deliveryIdx==null)return null;
  const no=p.deliveryPlanNo;
  if(no){
    const i=deliveries.findIndex(function(d){return d&&String(d.planNo||'')===String(no);});
    if(i>=0)return i;
  }
  return deliveries[p.deliveryIdx]?p.deliveryIdx:null;
}
/* 2026-10-07.138：排产行 → 交付计划行 / 归集 key 的**唯一解析口径**（事故根因 R2 防复发）。
   背景（R2 事故）：按 it.dlLine 直取交付计划行时不校验产品 → 别产品的完成量被记进本行
   （C04.03.008 曾把 C02.02.025 的 1100 台记到自己名下）。
   口径（保守，宁可退化也不误算）：
     ① dlLine 命中且该行 productId 与本排产行一致 → 采用
     ② 否则按 productId 在本交付计划内**唯一**匹配 → 采用
     ③ 多行歧义 / 无匹配 → null（归集退化到产品级 key，不污染任何订单行）
   buildPlannedUndelMap（done 归集）与 ppOrderLineOf（报工回写订单行）共用，**禁止二次实现**。 */
function ppDlRowOf(d,y){
  if(!d||!y)return null;
  const rows=deliveryItems(d);
  if(y.dlLine!=null){
    const c=rows[y.dlLine];
    if(c&&String(c.productId)===String(y.productId))return c;
  }
  const m=rows.filter(function(x){return x&&String(x.productId)===String(y.productId);});
  return m.length===1?m[0]:null;
}
/* 排产行在「已计划未交付 / 结余」归集里的 key：命中交付行且带订单行号 → 行级 key；否则产品级 key。
   与 renderOrderTable 的行键 r.__li 同为**订单行号**口径（index.html 消费侧一致）。 */
function ppDoneKeyOf(d,y){
  const r=ppDlRowOf(d,y);
  return (r&&r.orderLine!=null&&r.orderLine!=='')?(d.orderId+'|L'+r.orderLine):((d&&d.orderId)||'')+'|'+((y&&y.productId)||'');
}
/* 2026-10-07.138：排产单 → 交付计划「来源绑定」判定（**纯函数，不写任何字段**）。
   事故根因 R1：deliveries 删除只做 splice、全工程无重排 → 后续排产单引用集体前移，绑到别人的交付计划。
   返回 {act, from, to, level, cands, sigs}：
     act='skip'   独立单（无索引、无外键，复制单）——不参与绑定，恒不占额度
     act='keep'   绑定可信（外键命中 / 当前索引与订单+产品自洽）——只回填外键
     act='set'    需改写索引（外键目标已删→置 null / 唯一候选 / 归集等价的多候选 / 行号线索）
     act='manual' 无法唯一确定（零候选 / 多候选且归集口径不等价且无线索）——保持原样并记日志
   候选口径：同订单 + 每个排产行都能在候选计划内解析到**产品一致**的交付行 + 该行计划量 ≥ 本排产行计划量
             + 候选计划创建时间不晚于本排产单（时序硬约束）。
   等价口径：各候选导出的归集 key 序列完全相同 → 绑定结果对「已计划未交付 / 结余」无差别，取最小位移。 */
function ppDlLinkDecide(p){
  if(!p)return {act:'skip'};
  /* ① 外键优先：编号是稳定主键，抗索引漂移 */
  if(p.deliveryPlanNo){
    const i=deliveries.findIndex(function(d){return d&&String(d.planNo||'')===String(p.deliveryPlanNo);});
    if(i>=0)return {act:'keep',from:(p.deliveryIdx==null?null:p.deliveryIdx),to:i,level:'外键',cands:[i]};
    return {act:'set',from:(p.deliveryIdx==null?null:p.deliveryIdx),to:null,level:'外键目标已删',cands:[]};
  }
  if(p.deliveryIdx==null)return {act:'skip'};   /* 独立单 */
  const items=ppItems(p);
  const fits=function(d){
    return !!d && items.every(function(y){
      const r=ppDlRowOf(d,y);
      return !!r && num(r.planQty)>=ppPlanOf(y);
    });
  };
  /* ② 当前索引自洽（同订单 + 每行都能解析到产品一致的交付行）→ 认可 */
  const cur=deliveries[p.deliveryIdx];
  if(cur&&String(cur.orderId||'')===String(p.orderId||'')&&fits(cur))
    return {act:'keep',from:p.deliveryIdx,to:p.deliveryIdx,level:'当前索引自洽',cands:[p.deliveryIdx]};
  /* ③ 全库找候选 */
  const cands=[];
  const pd=String(p.id||'').replace(/^PSCD-/,'').slice(0,8);
  deliveries.forEach(function(d,di){
    if(String((d&&d.orderId)||'')!==String(p.orderId||''))return;
    if(!fits(d))return;
    const c=String(d.createdAt||'').replace(/[^0-9]/g,'').slice(0,8);
    if(c&&pd&&c>pd)return;                       /* 交付计划创建晚于排产单 → 逻辑上不可能 */
    cands.push(di);
  });
  if(!cands.length)return {act:'manual',from:p.deliveryIdx,to:null,level:'无候选',cands:[]};
  if(cands.length===1)return {act:'set',from:p.deliveryIdx,to:cands[0],level:'唯一候选',cands:cands};
  const sigOf=function(i){return items.map(function(y){return ppDoneKeyOf(deliveries[i],y);}).join('\u0001');};
  const s0=sigOf(cands[0]);
  const eq=cands.every(function(i){return sigOf(i)===s0;});
  if(eq){
    let best=cands[0];
    cands.forEach(function(i){
      const a=Math.abs(i-p.deliveryIdx),b=Math.abs(best-p.deliveryIdx);
      if(a<b||(a===b&&i<best))best=i;
    });
    return {act:'set',from:p.deliveryIdx,to:best,level:'归集等价的候选（'+cands.length+'）',cands:cands};
  }
  /* ④ 归集口径不等价：优先 dlLine 行号线索（该行号在候选内仍指向产品一致的行） */
  const hint=cands.filter(function(i){
    const rows=deliveryItems(deliveries[i]);
    return items.every(function(y){return y.dlLine!=null&&rows[y.dlLine]&&String(rows[y.dlLine].productId)===String(y.productId);});
  });
  if(hint.length===1)return {act:'set',from:p.deliveryIdx,to:hint[0],level:'行号线索',cands:cands};
  return {act:'manual',from:p.deliveryIdx,to:null,level:'候选 '+cands.length+' 个且归集口径不等价（线索 '+hint.length+'）',cands:cands};
}
/* 需求 2026-08-24.7：同一交付计划 + 同一产品，已下推的排产数量总和（编辑时 excludeIdx 排除自身） */
function ppPlannedOf(deliveryIdx,productId,excludeIdx){
  if(deliveryIdx==null)return 0;
  let s=0;
  productionPlans.forEach((p,idx)=>{
    if(idx===excludeIdx)return;
    if(ppDlIdxOf(p)!==deliveryIdx)return;
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
    if(idx===excludeIdx||ppDlIdxOf(p)!==deliveryIdx||p.status==='已取消')return false;
    return ppItems(p).some(it=>it.dlLine==null);
  });
  if(hasLegacy)return ppPlannedOf(deliveryIdx,productId,excludeIdx);
  let s=0;
  productionPlans.forEach((p,idx)=>{
    if(idx===excludeIdx||ppDlIdxOf(p)!==deliveryIdx||p.status==='已取消')return;
    ppItems(p).forEach(it=>{ if(it.dlLine===dlLine)s+=num(it.planQty); });
  });
  return s;
}
/* 交付计划已下推排产数量合计（build 2026-08-24.17）：Σ 名下排产单 items.planQty（排除已取消，同状态口径） */
function ppPlannedTotal(deliveryIdx){
  if(deliveryIdx==null)return 0;
  let planned=0;
  productionPlans.forEach(p=>{
    if(ppDlIdxOf(p)!==deliveryIdx)return;
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
