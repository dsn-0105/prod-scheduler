/* 2026-09-01 架构拆分批次5a：调拨模块（调用库存/退回库存/冲销/调拨台账）
   依赖全局（留在 index.html）：productPickerModal/orders/products/transfers/save/DB.set/
   syncStockFromInvOrders/syncOrderAutoStatus/logOp/canWriteKey/num/esc/showModal/closeModal/
   renderContent/clearHiddenOrderSel/orderRowVisibleInDom/TBL_SCHEMAS/TBL_ROWS/applyTable/
   slicePaged/pageSizeOf/pagerHtml/filterBar/thCol/colVal/currentUser/invQtyOf/saleMaxCallable/
   saleRemainCallable
   外部引用：onclick="csPickInv(...)/openCallStock(...)/openReturnStock(...)/reverseTransfer(...)/openInvCallStock(...)/openInvAdjust(...)"
   运行时调用本模块全局函数
   2026-10-10.143：「库存调整」（盘盈/盘亏）——按明细行调整库存订单已交付；单边调拨
     （applyTransfers 支持 out / in 恰有一侧为 null）；台账新增 remark（备注）字段与「备注」列
   2026-09-06.115：调拨方向模型（见下）
   2026-09-20.129：「退回库存」上限唯一口径 = 全局 saleMaxCallable（见 csReturnCap，严禁在本模块复制公式）
   2026-09-21.133：「调用库存」剩余可调用量唯一口径 = 全局 saleRemainCallable
     （= max(0, 未交付 − saleMaxCallable)，定义在 index.html）；本模块只委托、严禁复制公式
   2026-10-19.153：「调用库存」弹窗「选择库存订单」按**历史替换**推荐排序
     （csRankCands 排序副本 + buildSubstRankMap 推荐索引，判定复用全局 trCrossCallSides）；
     退回库存弹窗与默认预填口径均不变 */
/* ================================================================
   调拨方向模型（2026-09-06.115）
   - 台账字段从「销售订单/库存订单」（订单类型语义）改为「调出订单/调入订单」（方向语义）：
     out*=调出方（货物流出）、in*=调入方（货物流入），各自携带订单类型与明细行号。
   - 类型语义：call=销售调用库存（库存→销售）/ return=退回（销售→库存，也是 call 的冲销形）/
     conv=改装补库（库存→库存·跨料号）/ move=移库（库存→库存·同料号）/
     adjust_out=盘亏（.143 单边：仅 out，已交付减）/ adjust_in=盘盈（.143 单边：仅 in，已交付加）；
     冲销反向：call↔return、conv→conv_back（改装退回）、move→move_back（移库退回）、
               adjust_out↔adjust_in（盘亏↔盘盈，单边反向仍为单边）
   - 存量旧结构记录（salesOrderId/invOrderId/productId/invProductId…）经一次性数据迁移转新结构；
     trSide/trSnapOf 保留旧结构推导做防御兜底（渲染/冲销兼容未迁移记录）。
================================================================ */
var TR_TYPE_LABEL={call:'调用',return:'退回',conv:'改装',move:'移库',conv_back:'改装退回',move_back:'移库退回',adjust_out:'盘亏',adjust_in:'盘盈'};
var TR_TYPE_TAG={call:'tag-green',return:'tag-amber',conv:'tag-blue',move:'tag-gray',conv_back:'tag-blue',move_back:'tag-gray',adjust_out:'tag-red',adjust_in:'tag-green'};
var TR_TYPE_OPTIONS=['调用','退回','改装','移库','改装退回','移库退回','盘亏','盘盈'];
/* 冲销类型映射：call↔return / conv→conv_back / move→move_back / adjust_out↔adjust_in（幂等反向）
   2026-10-10.143：盘亏/盘盈为「单边调拨」（moves 的 out 或 in 恰有一侧为 null），
   反向时由 trRevType 给出对侧类型（adjust_out↔adjust_in），二次冲销回到原类型。 */
function trRevType(type){
  if(type==='call')return 'return';
  if(type==='return')return 'call';
  if(type==='conv')return 'conv_back';
  if(type==='conv_back')return 'conv';
  if(type==='move')return 'move_back';
  if(type==='move_back')return 'move';
  if(type==='adjust_out')return 'adjust_in';
  if(type==='adjust_in')return 'adjust_out';
  return null;
}
/* 取记录某一侧（out=调出/in=调入）→ {orderId,orderType,lineIdx,productId}；新结构直读，旧结构按 type 推导（防御） */
function trSide(t,side){
  if(!t)return {orderId:'',orderType:'',lineIdx:-1,productId:''};
  const sk=side+'OrderId',st=side+'OrderType',sl=side+'LineIdx',sp=side+'ProductId';
  if(t[sk]!=null&&t[st]!=null)return {orderId:t[sk],orderType:t[st],lineIdx:(t[sl]!=null?t[sl]:-1),productId:(t[sp]!=null?t[sp]:'')};
  /* 旧结构推导：call=库存调出→销售调入；return=销售调出→库存调入 */
  const salesAtOut=(t.type==='return');
  if(side==='out')return salesAtOut
    ?{orderId:t.salesOrderId,orderType:'sales',lineIdx:t.salesLineIdx,productId:t.productId}
    :{orderId:t.invOrderId,orderType:'inv',lineIdx:t.invLineIdx,productId:t.invProductId};
  return salesAtOut
    ?{orderId:t.invOrderId,orderType:'inv',lineIdx:t.invLineIdx,productId:t.invProductId}
    :{orderId:t.salesOrderId,orderType:'sales',lineIdx:t.salesLineIdx,productId:t.productId};
}
/* 台账快照（客户/合同/商品名/规格/型号）：新记录快照已存直接取；存量反查兜底。
   快照归属：参与方含销售订单→销售侧（调用/退回关联客户合同）；纯库存互调→调入侧库存行 */
function trSnapOf(t){
  if(!t)return {customer:'',contractNo:'',productName:'',spec:'',model:''};
  if(t.customer!=null&&t.productName!=null)return t;
  const outS=trSide(t,'out'),inS=trSide(t,'in');
  const side=(outS.orderType==='sales')?outS:inS;
  const o=orders.find(function(x){return x.id===side.orderId;});
  const it=o&&(o.items||[])[side.lineIdx];
  return {customer:o?(o.customer||''):'',contractNo:o?(o.contractNo||''):'',
    productName:it?(it.productName||it.productId||''):'',
    spec:it?(it.spec||''):'',model:it?(it.model||''):''};
}
let __csCands=[],__csLines=[],__csMode='call',__csOrder=null;
/* 2026-09-20.129：「退回库存」行级上限（可退回量）的**唯一口径入口**——直接委托全局函数
   saleMaxCallable（定义在 index.html，.108 交付侧同源），本模块**不得**复制该公式
   （口径双源是本项目明令禁止的；.129 前退回弹窗误用 deliveredQty，属业务口径错误）。
   语义：可退回量 = 已调用 − max(0, 已交付 − 期初直接交付)
        = 调用进来、尚未发给客户、仍压在手上可退回库存的量。
   入参 line 须带 calledQty / deliveredQty / directDelivered（缺省按 0，与全局 num() 一致）。 */
function csReturnCap(line){
  return saleMaxCallable(line);
}
/* 2026-10-19.153：库存候选排序（仅「调用库存」弹窗使用）。
   次序＝**同料号（恒第一）→ 该行料号历史上的替换料号（按推荐索引名次）→ 其它**；
   同档内按「可用量」降序；仍相同则保持原顺序（稳定、可复现）。
   ⚠ 返回**新数组**（元素仍是原候选对象引用，浅拷贝不改对象）——入参 cands 的顺序绝对不能被改：
     `.cs-inv-box[data-ci]` 存的是**下标**，csWarn / csAutoFill / doCallStock 全靠它取候选，
     原地 sort 会让已写入的 data-ci 全部错位 → 静默取到错的库存订单（把货调错）。
   recs = buildSubstRankMap().get(销售料号) 的结果（已按次数/最近时间排好）。 */
function csRankCands(cands,pid,recs){
  const order={};
  (recs||[]).forEach(function(r,i){order[String(r.code)]=i;});
  const target=String(pid==null?'':pid);
  function wt(c){
    const code=String(c&&c.productId==null?'':c.productId);
    if(code===target)return -1;                                  /* 同料号恒第一 */
    if(Object.prototype.hasOwnProperty.call(order,code))return order[code];   /* 历史替换名次 0,1,2… */
    return 1e6;                                                   /* 其它 */
  }
  return (cands||[]).map(function(c,i){return {c:c,i:i};}).sort(function(a,b){
    const wa=wt(a.c),wb=wt(b.c);
    if(wa!==wb)return wa-wb;
    const d=num(b.c&&b.c.available)-num(a.c&&a.c.available);
    if(d)return d;
    return a.i-b.i;
  }).map(function(x){return x.c;});
}
/* 2026-08-25.51：打开库存订单选择弹窗（单选，复用 productPickerModal 参数化版，列表可筛选）
   2026-10-19.153：**仅「调用库存」模式**按历史替换推荐排在最前（退回库存弹窗口径不变，用户拍板） */
function csPickInv(li){
  const line=__csLines.find(function(l){return l.i===li;});
  const isCall=(__csMode==='call');
  const pid=String((line&&line.productId)||'');
  /* 推荐索引与排序副本：__csCands 本身不动（见 csRankCands 头部 data-ci 说明） */
  const recs=isCall?(buildSubstRankMap().get(pid)||[]):[];
  const rows=isCall?csRankCands(__csCands,pid,recs):__csCands;
  const schema=[
    {key:'invOrderId',label:'库存订单',type:'text'},
    {key:'productId',label:'编码',type:'text',get:function(c){
      const code=String(c.productId==null?'':c.productId);
      const r=recs.find(function(x){return x.code===code;});
      return code+(r?(' ★常用替换×'+r.cnt):'');   /* ★ = 该料号历史上替换过本行料号 */
    }},
    {key:'productName',label:'名称',type:'text'},
    {key:'model',label:'型号',type:'text'},
    {key:'spec',label:'规格',type:'text'},
    {key:'available',label:'可用量',type:'number'}
  ];
  productPickerModal({
    mode:'single', title:'选择库存订单', clickSelect:true,   /* 2026-08-29.84：点击行直接选中（立即确认回填） */
    note:recs.length
      ?('「'+esc(pid)+'」历史替换：'+recs.map(function(r){return esc(r.code)+'×'+r.cnt;}).join('、')
        +'。排序＝同料号（恒第一）→ 历史替换（按次数，次数相同看最近）→ 其它；★ 为历史替换料号，可用量为负仍按次数排在前，请核对「可用量」。')
      :'',
    rows:rows, schema:schema,
    onConfirm:function(ids){
      const c=ids&&ids.length?__csCands.find(function(x){return x.uid===ids[0];}):null;
      csSetInv(li,c||null);
    }
  });
}
/* 回填选择框：显示 库存订单号 · 编码 名称 [型号 / 规格] 可用 N */
function csSetInv(li,c){
  const box=document.querySelector('.cs-inv-box[data-li="'+li+'"]');
  if(!box)return;
  box.dataset.ci=c?String(__csCands.indexOf(c)):'';
  box.innerHTML=c
    ?('<b>'+esc(c.invOrderId)+'</b> · '+esc(c.productId||'')+(c.productName?' '+esc(c.productName):'')+((c.model||c.spec)?' ['+esc([c.model,c.spec].filter(Boolean).join(' / '))+']':'')+' <span style="color:var(--muted)">可用'+c.available+'</span>')
    :'<span style="color:var(--muted)">'+(__csMode==='call'?'（不调用）':'（不退回）')+'</span>';
  csWarn(li);
}
function csClearInv(li){csSetInv(li,null);}
function csAttach(){
  document.querySelectorAll('.cs-inv-box').forEach(function(box){csWarn(Number(box.dataset.li));});
}
function csWarn(li){
  const box=document.querySelector('.cs-inv-box[data-li="'+li+'"]');
  const warn=document.querySelector('.cs-warn[data-li="'+li+'"]');
  const qinp=document.querySelector('.cs-qty[data-li="'+li+'"]');
  if(!box)return;
  const ci=box.dataset.ci==='' ? -1 : Number(box.dataset.ci);
  if(ci<0){if(warn)warn.textContent='';return;}
  const c=__csCands[ci];
  const line=__csLines.find(function(l){return l.i===li;});
  if(!c||!line)return;
  if(c.productId!==line.productId){if(warn)warn.textContent='⚠ 跨料号替代：将用【'+esc(c.productId)+'】库存履行【'+esc(line.productId)+'】';}
  else if(warn)warn.textContent='';
  if(qinp){
    /* 2026-08-25.20：调用数量上限=销售未交付（放开库存可用量，可超调=欠货）
       2026-09-20.129：退回上限口径修正——由「销售已交付」改为「该行可退回量」（csReturnCap → saleMaxCallable，与 .108 交付侧同源）
       2026-09-21.133：调用上限口径修正——由「销售未交付」改为「该行剩余可调用量」
       （saleRemainCallable → 未交付 − saleMaxCallable，与 .108 交付侧 / .129 退回侧同源，单一口径委托） */
    const max=__csMode==='call'?saleRemainCallable(line.it):csReturnCap(line);
    qinp.max=max;
  }
}
/* 自动填充：将每行调用/退回数量填为该行所选库存订单的可用最大值（按已分配量扣减，避免超额）。未选择库存订单的行填 0。 */
function csAutoFill(){
  if(!__csLines||!__csCands)return;
  const used={};
  document.querySelectorAll('.cs-qty').forEach(function(inp){
    const li=Number(inp.dataset.li);
    const box=document.querySelector('.cs-inv-box[data-li="'+li+'"]');
    if(!box||box.dataset.ci===''){inp.value=0;return;}
    const ci=Number(box.dataset.ci);
    const c=__csCands[ci];if(!c){inp.value=0;return;}
    const line=__csLines.find(function(l){return l.i===li;});if(!line){inp.value=0;return;}
    /* 2026-08-25.20：调用上限=未交付；2026-09-20.129：退回上限=该行可退回量（csReturnCap，单一口径来源）
       2026-09-21.133：调用上限=该行剩余可调用量（saleRemainCallable，单一口径委托） */
    const cap=__csMode==='call'?saleRemainCallable(line.it):csReturnCap(line);
    const curAvail=c.available-(used[ci]||0);
    const q=Math.max(0,Math.min(curAvail,cap));
    used[ci]=(used[ci]||0)+q;
    inp.value=q;
  });
  document.querySelectorAll('.cs-qty').forEach(function(inp){csWarn(Number(inp.dataset.li));});
}
/* 2026-08-25.57：自动填充展开框——按库存可用量（原逻辑）/ 按剩余订单数量（全部行填该行剩余可调用量） */
function csToggleFillMenu(btn){
  const old=document.getElementById('csFillMenu');
  if(old){old.remove();return;}
  const m=document.createElement('div');
  m.id='csFillMenu';
  m.style.cssText='position:fixed;z-index:260;background:var(--bg,#fff);border:1px solid #d1d5db;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.12);min-width:150px;padding:4px;font-size:13px';
  m.innerHTML='<div class="cs-fill-opt" style="padding:6px 10px;cursor:pointer;border-radius:4px" onmouseover="this.style.background=\'rgba(0,0,0,.06)\'" onmouseout="this.style.background=\'\'" onclick="csAutoFill();csToggleFillMenu()">按库存可用量填充</div>'
    +'<div class="cs-fill-opt" style="padding:6px 10px;cursor:pointer;border-radius:4px" onmouseover="this.style.background=\'rgba(0,0,0,.06)\'" onmouseout="this.style.background=\'\'" onclick="csFillByOrder();csToggleFillMenu()">按剩余订单数量填充</div>';
  const r=btn.getBoundingClientRect();
  m.style.left=Math.max(8,r.left)+'px';
  m.style.top=(r.bottom+4)+'px';
  document.body.appendChild(m);
}
/* 按剩余订单数量填充：所有行的调用数量填为该行剩余可调用量（= 未交付 − 已调用未发出；超库存可用量=欠货，.20 已放开） */
function csFillByOrder(){
  if(!__csLines)return;
  document.querySelectorAll('.cs-qty').forEach(function(inp){
    const li=Number(inp.dataset.li);
    const line=__csLines.find(function(l){return l.i===li;});
    if(!line)return;
    /* 2026-08-25.20：调用=未交付；2026-09-20.129：退回=该行可退回量（csReturnCap，单一口径来源）
       2026-09-21.133：调用=该行剩余可调用量（saleRemainCallable，单一口径委托，超调行自然填 0） */
    const cap=__csMode==='call'?saleRemainCallable(line.it):csReturnCap(line);
    inp.value=Math.max(0,cap);
  });
  document.querySelectorAll('.cs-qty').forEach(function(inp){csWarn(Number(inp.dataset.li));});
}
function openCallStock(){
  if(!needAct('order_frame.saleCall'))return;   /* .119：动作键 saleCall（默认经理） */
  const s=selSet('order_frame');
  if(s.size===0){alert('请先勾选 1 张销售订单');return;}
  if(s.size>1){alert('「调用库存」只能选择 1 张销售订单，当前已选 '+s.size+' 张。');return;}
  const o=orders[Number([...s][0])];
  if(!o){alert('未找到订单');return;}
  if(orderTypeOf(o)!=='销售订单'){alert('「调用库存」仅适用于销售订单');return;}
  if(o.status==='已取消'||o.status==='已暂停'){alert('订单「'+o.id+'」已'+o.status+'，无法调用库存');return;}
  /* 2026-09-21.133：调用侧行级上限口径修正（用户报告的 Bug）——可调用余量 = saleRemainCallable(it)
     = max(0, 未交付 − saleMaxCallable)（与 .108 交付侧 / .129 退回侧同源）；.133 前误用「未交付」，
     未扣减已调用 calledQty，导致「已调用 5 再填 38（订单 38）」被放行 → 累计超调。
     行对象携带 item 引用（it:it），供 saleRemainCallable/csWarn/csAutoFill/csFillByOrder/doCallStock
     统一委托全局单一口径；既有字段保留不动。 */
  const lines=(o.items||[]).map(function(it,i){return {i:i,it:it,productId:it.productId,productName:it.productName,spec:it.spec||'',model:it.model||'',orderQty:num(it.orderQty),deliveredQty:num(it.deliveredQty)};})
    .filter(function(l){return saleRemainCallable(l.it)>0;});
  if(!lines.length){alert('该销售订单所有明细剩余可调用量均为 0，无可调用库存');return;}
  const prodMap={};products.forEach(function(p){prodMap[p.id]=p;});
  const cands=[];
  orders.forEach(function(inv){
    if(orderTypeOf(inv)!=='库存订单')return;
    (inv.items||[]).forEach(function(it,ii){
      const av=num(it.deliveredQty);
      /* 2026-08-25.53/.56：只要存在库存订单行即显示可选（可用量 0/负/正均可选）——0 可用=手动调用后从 0 转正（.20 已放开超可用量校验）；负数=欠货调用后向 0 恢复 */
      const prod=prodMap[it.productId]||{};
      cands.push({uid:inv.id+'#'+ii,invOrderId:inv.id,invLineIdx:ii,productId:it.productId,productName:it.productName,available:av,spec:it.spec||prod.spec||'',model:it.model||prod.model||''});
    });
  });
  __csCands=cands;__csLines=lines;__csMode='call';
  let rows='';
  lines.forEach(function(l){
    const undel=Math.max(0,l.orderQty-l.deliveredQty);
    /* 2026-09-21.133：行提示补「已调用 M · 可调用 K」三个数（与 openReturnStock 的 .129 三数提示风格一致），
       便于同事核算可调用余量。三个数先取到局部量再拼串：保证本模块正文除「委托全局函数」外不出现口径算式痕迹
       （QA 静态守卫 B4/B6）。 */
    const cq=num(l.it.calledQty);
    const rem=saleRemainCallable(l.it);
    const pm=[l.model,l.spec].filter(Boolean).join(' / ');
    let def=cands.filter(function(c){return c.productId===l.productId;}).sort(function(a,b){return b.available-a.available;})[0];
    /* 2026-08-25.51：下拉改选择框（单选弹窗+筛选）——显示 编码/名称/型号/规格/可用量，默认预填同料号最大可用 */
    const boxHtml=def?('<b>'+esc(def.invOrderId)+'</b> · '+esc(def.productId||'')+(def.productName?' '+esc(def.productName):'')+((def.model||def.spec)?' ['+esc([def.model,def.spec].filter(Boolean).join(' / '))+']':'')+' <span style="color:var(--muted)">可用'+def.available+'</span>')
      :'<span style="color:var(--muted)">（不调用）</span>';
    rows+='<tr data-li="'+l.i+'"><td>'+esc(l.productName||l.productId)+'<br><span style="color:var(--muted);font-size:12px">'+esc(l.productId)+(pm?' ['+esc(pm)+']':'')+' 未交付 '+undel+' · 已调用 '+cq+' · 可调用 '+rem+'</span></td>'
      +'<td style="min-width:260px"><div class="cs-inv-box" data-li="'+l.i+'" data-ci="'+(def?cands.indexOf(def):'')+'" style="background:var(--bg2,transparent);border:1px solid #d1d5db;border-radius:6px;padding:4px 8px;font-size:12px;margin-bottom:4px">'+boxHtml+'</div>'
      +'<div style="display:flex;gap:4px"><button class="btn btn-sm" onclick="csPickInv('+l.i+')">选择</button>'
      +'<button class="btn btn-sm" onclick="csClearInv('+l.i+')">清除</button></div>'
      +'<div class="cs-warn" data-li="'+l.i+'" style="color:var(--red);font-size:12px"></div></td>'
      +'<td><input type="number" class="cs-qty" data-li="'+l.i+'" min="0" value="0" style="width:90px"></td></tr>';
  });
  const body='<p style="color:var(--muted);font-size:13px">为「'+esc(o.id)+'」的每条明细选择被调用的库存订单（默认同料号，跨料号将提示）。调用数量不可超过该行剩余可调用量（剩余可调用量 = 未交付 − 已调用未发出，与 .108 交付口径同源）；可超出库存可用量，超出部分库存订单记欠货（已交付为负）。</p>'
    +'<div class="table-wrap"><table><thead><tr><th>销售明细</th><th>调用库存订单</th><th>调用数量</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  __csOrder=o;
  showModal('调用库存 - '+esc(o.id),body,
    /* 2026-08-25.57：自动填充 + 右侧展开框（按库存可用量 / 按剩余订单数量=填该行剩余可调用量） */
    '<span style="position:relative"><button class="btn" onclick="csAutoFill()">自动填充</button>'+
    '<button class="btn" onclick="csToggleFillMenu(this)" title="更多填充方式" style="padding:2px 7px">▾</button></span>'+
    '<button class="btn btn-primary" onclick="doCallStock(__csOrder)">确认调用</button>'+
    '<button class="btn" onclick="closeModal()">取消</button>');
  csAttach();
}
/* 【P1 事务化】调用方改为 async + await：等待 applyTransfers 的一次 /api/tx 落盘后再报成功（设计 §4.1 ⑥） */
async function doCallStock(o){
  const moves=[];let any=false;
  document.querySelectorAll('.cs-qty').forEach(function(inp){
    const li=Number(inp.dataset.li);
    const q=num(inp.value);
    if(q<=0)return;
    const box=document.querySelector('.cs-inv-box[data-li="'+li+'"]');
    const ci=box?(box.dataset.ci===''?-1:Number(box.dataset.ci)):-1;
    if(ci<0){alert('第'+(li+1)+'行未选择库存订单');return;}
    const c=__csCands[ci];
    const line=__csLines.find(function(l){return l.i===li;});
    /* 2026-08-25.20：放开「不超过库存可用量」校验（可超调=库存订单记欠货），仅校验不超过该行上限
       2026-09-21.133：硬校验同步改为「该行剩余可调用量」（saleRemainCallable，单一口径委托，与 .108/.129 同源）；
       错误提示带出 订单数量/已交付/已调用/剩余可调用量 四个数，方便同事理解为什么被拦。
       四个数先取到局部量再拼串：正文不出现口径算式痕迹（QA 静态守卫 B4/B6）。 */
    const cap=saleRemainCallable(line.it);
    if(q>cap){
      const oq=line.orderQty;
      const dq=line.deliveredQty;
      const cq=num(line.it.calledQty);
      alert('调用数量 '+q+' 超过该行剩余可调用量 '+cap+'（订单数量 '+oq+' / 已交付 '+dq+' / 已调用 '+cq+' / 剩余可调用量 '+cap+'）');
      return;
    }
    moves.push({out:{orderId:c.invOrderId,orderType:'inv',lineIdx:c.invLineIdx},in:{orderId:o.id,orderType:'sales',lineIdx:li},qty:q});
    any=true;
  });
  if(!any){alert('未填写任何调用数量');return;}
  if(await applyTransfers('call',moves)){
    logOp('调用库存','订单管理','销售订单 '+o.id+' 调用库存');
    renderContent();
    clearGhostSel(moves.map(function(mv){return mv.out.orderId;}).concat([o.id]));
  }else{
    alertTransferFailed();
  }
  closeModal();
}
function openReturnStock(){
  if(!needAct('order_frame.saleReturnStock'))return;   /* .119：动作键 saleReturnStock（默认经理） */
  const s=selSet('order_frame');
  if(s.size===0){alert('请先勾选 1 张销售订单');return;}
  if(s.size>1){alert('「退回库存」只能选择 1 张销售订单，当前已选 '+s.size+' 张。');return;}
  const o=orders[Number([...s][0])];
  if(!o){alert('未找到订单');return;}
  if(orderTypeOf(o)!=='销售订单'){alert('「退回库存」仅适用于销售订单');return;}
  if(o.status==='已取消'||o.status==='已暂停'){alert('订单「'+o.id+'」已'+o.status+'，无法退回库存');return;}
  /* 2026-09-20.129：可退回量口径修正（用户报告的 Bug）——行级上限 = csReturnCap → 全局 saleMaxCallable
     （= 已调用 − max(0, 已交付 − 期初直接交付)，与 .108 交付侧同源）；.129 前误用「已交付」，
     使「期初直接交付基数大 / 未调用」的行被误判为可退。行对象需带 calledQty/directDelivered。 */
  const lines=(o.items||[]).map(function(it,i){return {i:i,productId:it.productId,productName:it.productName,spec:it.spec||'',model:it.model||'',orderQty:num(it.orderQty),deliveredQty:num(it.deliveredQty),calledQty:num(it.calledQty),directDelivered:num(it.directDelivered)};})
    .filter(function(l){return csReturnCap(l)>0;});
  if(!lines.length){alert('该销售订单所有明细可退回量为 0，无可供退回的库存');return;}
  const prodMap={};products.forEach(function(p){prodMap[p.id]=p;});
  const cands=[];
  orders.forEach(function(inv){
    if(orderTypeOf(inv)!=='库存订单')return;
    (inv.items||[]).forEach(function(it,ii){
      const prod=prodMap[it.productId]||{};cands.push({invOrderId:inv.id,invLineIdx:ii,productId:it.productId,productName:it.productName,available:num(it.deliveredQty),spec:it.spec||prod.spec||'',model:it.model||prod.model||''});
    });
  });
  __csCands=cands;__csLines=lines;__csMode='return';
  let rows='';
  lines.forEach(function(l){
    const pm=[l.model,l.spec].filter(Boolean).join(' / ');
    let def=cands.filter(function(c){return c.productId===l.productId;})[0];
    /* 2026-08-25.51：退回弹窗同款选择框（单选弹窗+筛选） */
    const boxHtml=def?('<b>'+esc(def.invOrderId)+'</b> · '+esc(def.productId||'')+(def.productName?' '+esc(def.productName):'')+((def.model||def.spec)?' ['+esc([def.model,def.spec].filter(Boolean).join(' / '))+']':'')+' <span style="color:var(--muted)">可用'+def.available+'</span>')
      :'<span style="color:var(--muted)">（不退回）</span>';
    /* 2026-09-20.129：行提示补「已调用 / 已交付 / 可退」三个数，便于同事核算退回量。
       数量先取到局部量再拼串：保证本模块正文除了「委托 saleMaxCallable」外不出现任何口径算式痕迹
       （QA 静态守卫 B4：正文不得出现 calledQty 与 deliveredQty 的组合）。 */
    const dqR=l.deliveredQty;
    const cqR=l.calledQty;
    const capR=csReturnCap(l);
    rows+='<tr data-li="'+l.i+'"><td>'+esc(l.productName||l.productId)+'<br><span style="color:var(--muted);font-size:12px">'+esc(l.productId)+(pm?' ['+esc(pm)+']':'')+' 已调用 '+cqR+' · 已交付 '+dqR+' · 可退 '+capR+'</span></td>'
      +'<td style="min-width:260px"><div class="cs-inv-box" data-li="'+l.i+'" data-ci="'+(def?cands.indexOf(def):'')+'" style="background:var(--bg2,transparent);border:1px solid #d1d5db;border-radius:6px;padding:4px 8px;font-size:12px;margin-bottom:4px">'+boxHtml+'</div>'
      +'<div style="display:flex;gap:4px"><button class="btn btn-sm" onclick="csPickInv('+l.i+')">选择</button>'
      +'<button class="btn btn-sm" onclick="csClearInv('+l.i+')">清除</button></div>'
      +'<div class="cs-warn" data-li="'+l.i+'" style="color:var(--red);font-size:12px"></div></td>'
      +'<td><input type="number" class="cs-qty" data-li="'+l.i+'" min="0" max="'+csReturnCap(l)+'" value="0" style="width:90px"></td></tr>';
  });
  const body='<p style="color:var(--muted);font-size:13px">为「'+esc(o.id)+'」的每条可退回明细选择退回目标库存订单（默认同料号，跨料号将提示）。退回数量不可超过该行可退回量（可退回量 = 已调用 − 超出期初直接交付基数的已交付，与 .108 交付口径同源）。</p>'
    +'<div class="table-wrap"><table><thead><tr><th>销售明细</th><th>退回目标库存订单</th><th>退回数量</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  __csOrder=o;
  showModal('退回库存 - '+esc(o.id),body,
    '<button class="btn" onclick="csAutoFill()">自动填充</button>'+
    '<button class="btn btn-primary" onclick="doReturnStock(__csOrder)">确认退回</button>'+
    '<button class="btn" onclick="closeModal()">取消</button>');
  csAttach();
}
/* 【P1 事务化】同上：async + await */
async function doReturnStock(o){
  const moves=[];let any=false;
  document.querySelectorAll('.cs-qty').forEach(function(inp){
    const li=Number(inp.dataset.li);
    const q=num(inp.value);
    if(q<=0)return;
    const box=document.querySelector('.cs-inv-box[data-li="'+li+'"]');
    const ci=box?(box.dataset.ci===''?-1:Number(box.dataset.ci)):-1;
    if(ci<0){alert('第'+(li+1)+'行未选择库存订单');return;}
    const line=__csLines.find(function(l){return l.i===li;});
    /* 2026-09-20.129：硬校验同步改为「该行可退回量」（csReturnCap → saleMaxCallable，与 .108 交付侧同源）；
       错误提示带出 已调用/已交付/期初直接交付/可退 四个数，方便同事理解为什么被拦。
       四个数先取到局部量再拼串：正文不出现口径算式痕迹（QA 静态守卫 B4）。 */
    const cap=csReturnCap(line);
    if(q>cap){
      const dq=line.deliveredQty;
      const cq=line.calledQty;
      alert('退回数量 '+q+' 超过该行可退回量 '+cap+'（已调用 '+cq+' / 已交付 '+dq+' / 期初直接交付 '+line.directDelivered+' / 可退 '+cap+'）');
      return;
    }
    const c=__csCands[ci];
    moves.push({out:{orderId:o.id,orderType:'sales',lineIdx:li},in:{orderId:c.invOrderId,orderType:'inv',lineIdx:c.invLineIdx},qty:q});
    any=true;
  });
  if(!any){alert('未填写任何退回数量');return;}
  if(await applyTransfers('return',moves)){
    logOp('退回库存','订单管理','销售订单 '+o.id+' 退回库存');
    renderContent();
    clearGhostSel(moves.map(function(mv){return mv.in.orderId;}).concat([o.id]));
  }else{
    alertTransferFailed();
  }
  closeModal();
}
/* ================================================================
   2026-09-06.115：通用调拨执行（方向模型，替代原 applyStockMove 二元模型）
   moves: [{out:{orderId,orderType,lineIdx}|null, in:{orderId,orderType,lineIdx}|null, qty}]
   type: call/return/conv/move/conv_back/move_back/adjust_out/adjust_in
         （conv_back/move_back 供冲销反向；adjust_out/adjust_in=盘亏/盘盈，单边调拨）
   opts.reverseOf: 冲销生成记录时指向被冲销的原记录 id
   opts.remark: 台账备注（调整原因）；mv.remark 优先于 opts.remark
   数量规则（方向语义=货物 out 流向 in）：
     参与方为库存订单 → 明细 deliveredQty（out 减 / in 加，可负=欠货，.20 口径）
     参与方为销售订单 → 明细 calledQty（out 减 / in 加，下限 0；.97 已交付由交付/退货驱动）
     【2026-10-10.143】单边调拨：out / in 恰有一侧为 null 时只驱动存在侧（盘亏=仅 out、盘盈=仅 in）；
       两侧皆 null 整批返回 false。缺省侧台账字段写 '' / null，不在本函数内做任何可用量口径计算。
   台账快照：参与方含销售订单→取销售侧订单/行（客户/合同/商品名）；纯库存互调→调入侧库存行；
             单边调拨→取唯一存在侧
   ================================================================
   【P1 事务化】2026-09-11.124：写入收尾由「两次独立 save + 一次 DB.set」改为**一次 /api/tx**。
   事实表 orders / transfers 必然同事务；products（库存=Σ库存订单已交付）为派生投影，
   仅在真有变化时作为伴随 op 并入同一次提交（投影「写盘前」重算，设计 §4.1 ④ / §4.4）。
   本函数因此变为 **async**，返回 Promise<boolean>（true=整批落盘；false=整批未生效且内存已复原）。
   ================================================================ */
async function applyTransfers(type,moves,opts){
  if(!moves||!moves.length)return false;
  /* 2026-10-10.143：单边调拨支持——盘盈/盘亏只有一侧参与方（out 或 in 恰有一侧为 null），
     数量只驱动存在侧；两侧皆 null 视为非法整批放弃（防御）。
     台账流水仍为本函数**唯一写入器**（严禁另建第二份写入逻辑）。 */
  for(const mv of moves){
    const outMv=mv.out||null,inMv=mv.in||null;
    if(!outMv&&!inMv)return false;
    if(outMv){
      const oo=orders.find(function(o){return o.id===outMv.orderId;});
      if(!oo||!Array.isArray(oo.items)||!(oo.items||[])[outMv.lineIdx])return false;
    }
    if(inMv){
      const oi=orders.find(function(o){return o.id===inMv.orderId;});
      if(!oi||!Array.isArray(oi.items)||!(oi.items||[])[inMv.lineIdx])return false;
    }
  }
  moves.forEach(function(mv){
    const outMv=mv.out||null,inMv=mv.in||null;
    /* 2026-08-25.20：库存订单已交付允许负数（调用超量=欠货，盘亏同理）；销售 calledQty 下限 0 */
    if(outMv){
      const oo=orders.find(function(o){return o.id===outMv.orderId;});
      const oit=(oo.items||[])[outMv.lineIdx];
      if(outMv.orderType==='inv')oit.deliveredQty=num(oit.deliveredQty)-mv.qty;
      else oit.calledQty=Math.max(0,num(oit.calledQty)-mv.qty);
    }
    if(inMv){
      const oi=orders.find(function(o){return o.id===inMv.orderId;});
      const iit=(oi.items||[])[inMv.lineIdx];
      if(inMv.orderType==='inv')iit.deliveredQty=num(iit.deliveredQty)+mv.qty;
      else iit.calledQty=Math.max(0,num(iit.calledQty)+mv.qty);
    }
  });
  /* 【P1 事务化】投影前置重算（纯函数，只改内存）：库存投影 + 订单状态投影。
     先算后写 = 与「写盘后触发」逐字节同值，且消除第二个失败点（设计 §4.4 三条理由）。 */
  const stockChanged=recomputeStockFromInvOrders();
  recomputeOrderAutoStatus();   // 2026-08-25.3：调拨后按未交付合计自动判定状态（orders 恒在 tx 内，状态随之落盘）
  const ts=new Date().toLocaleString('zh-CN',{hour12:false});
  const user=(currentUser&&currentUser.name)||(currentUser&&currentUser.username)||'未知';
  moves.forEach(function(mv,idx){
    const outMv=mv.out||null,inMv=mv.in||null;
    const oo=outMv?orders.find(function(o){return o.id===outMv.orderId;}):null;
    const oi=inMv?orders.find(function(o){return o.id===inMv.orderId;}):null;
    const oit=(oo&&outMv)?(oo.items||[])[outMv.lineIdx]:null;
    const iit=(oi&&inMv)?(oi.items||[])[inMv.lineIdx]:null;
    /* 快照归属：销售侧优先（客户/合同）→ 两侧皆非销售（含 conv/move）取**调入侧** → in 缺失
       （单边盘亏）才取调出侧兜底。不得写成「out 优先」：conv/move 台账「产品/料号」列取调入侧
       （renderTransfers），快照若取调出侧会导致同一行「商品名称」与「料号」指向两个产品。 */
    const snap=(outMv&&outMv.orderType==='sales')?{o:oo,it:oit}
      :(inMv?{o:oi,it:iit}:{o:oo,it:oit});
    /* 缺省侧（单边调拨不存在的一侧）写空串/ null，使 trSide 走「新结构直读」分支并返回安全默认值
       （trSide 判定 t[sk]!=null && t[st]!=null，空串满足非 null → lineIdx 兜底 -1、productId 兜底 ''） */
    transfers.unshift({
      id:'TR'+Date.now()+'-'+idx,type:(mv.type||type),
      outOrderId:outMv?outMv.orderId:'',outOrderType:outMv?outMv.orderType:'',outLineIdx:outMv?outMv.lineIdx:null,outProductId:oit?oit.productId:'',
      inOrderId:inMv?inMv.orderId:'',inOrderType:inMv?inMv.orderType:'',inLineIdx:inMv?inMv.lineIdx:null,inProductId:iit?iit.productId:'',
      qty:mv.qty,ts:ts,user:user,reversed:false,reverseOf:(opts&&opts.reverseOf)||null,
      /* 2026-10-10.143：调整原因备注（盘亏/盘盈盘点差异说明；既有类型缺省空串，行为不变） */
      remark:(mv.remark||(opts&&opts.remark)||''),
      /* 2026-08-25.49：台账快照（历史记录不随订单后续编辑变化；存量单渲染反查兜底） */
      customer:snap.o?(snap.o.customer||''):'',contractNo:snap.o?(snap.o.contractNo||''):'',
      productName:snap.it?(snap.it.productName||''):'',
      spec:snap.it?(snap.it.spec||''):'',model:snap.it?(snap.it.model||''):''
    });
  });
  /* 【P1 事务化】一次原子提交：orders（事实·明细数量+状态） + transfers（事实·台账）
     + products（派生投影，仅变化时）。silent=true：提示由调用方决定（设计 §4.1 ⑤/⑥）。 */
  const ops=[{key:'orders',value:orders},{key:'transfers',value:transfers}];
  if(stockChanged)ops.push({key:'products',value:products});
  return await DB.tx(ops,true);
}
/* 【P1 事务化】调拨失败统一提示：DB.tx 已 pullAll 复原内存，故本次调拨整体未生效。 */
function alertTransferFailed(){
  alert('调拨保存失败：为避免数据不一致，本次调拨整体未生效（订单、库存、台账均未改动）。\n请刷新页面后重试。');
}
/* 调拨/冲销后清理被筛选隐藏订单的幽灵勾选（2026-08-25.5，此时 DOM 已按新状态渲染） */
function clearGhostSel(orderIds){
  (orderIds||[]).forEach(function(id){
    const ix=orders.findIndex(function(x){return x.id===id;});
    if(ix>=0&&!orderRowVisibleInDom(orders[ix].id))clearHiddenOrderSel(ix);
  });
}
/* 【P1 事务化】同上：async + await */
async function reverseTransfer(id){
  if(!canWriteKey('transfers')){alert('当前账号无调拨台账编辑权限');return;}
  const t=transfers.find(function(x){return x.id===id;});
  if(!t){alert('未找到记录');return;}
  if(t.reversed){alert('该记录已冲销');return;}
  if(!confirm('确认冲销该调拨记录？将生成一条反向记录。'))return;
  const outS=trSide(t,'out'),inS=trSide(t,'in');
  /* 2026-10-10.143：放宽为「至少一侧存在」——盘亏/盘盈为单边记录（另一侧 orderId 为空串）。
     只校验存在侧的订单/明细；缺省侧原样保持单边形态（构造反向 moves 时传 null）。 */
  const hasOut=!!outS.orderId,hasIn=!!inS.orderId;
  if(!hasOut&&!hasIn){alert('记录缺少调出/调入方信息，无法冲销');return;}
  const revType=trRevType(t.type);
  if(!revType){alert('未知调拨类型，无法冲销');return;}
  if(hasOut){
    const outO=orders.find(function(x){return x.id===outS.orderId;});
    if(!outO||!(outO.items||[])[outS.lineIdx]){alert('关联订单/明细已不存在，无法冲销');return;}
  }
  if(hasIn){
    const inO=orders.find(function(x){return x.id===inS.orderId;});
    if(!inO||!(inO.items||[])[inS.lineIdx]){alert('关联订单/明细已不存在，无法冲销');return;}
  }
  /* 反向执行：原调出方收回、原调入方退回 —— 方向对调（原 out 当 in、原 in 当 out）后数量自动反向滚回；
     单边记录对调后仍为单边（缺省侧传 null，反向语义由 revType 表达）。
     .97 口径：销售订单已交付不随调拨变动（由交付/退货操作驱动），仅滚回库存已交付与销售 calledQty。
     .115：conv/move 冲销生成 conv_back/move_back（改装退回/移库退回）反向记录，reverseOf 指向原记录 */
  const revOut=hasIn?{orderId:inS.orderId,orderType:inS.orderType,lineIdx:inS.lineIdx}:null;
  const revIn=hasOut?{orderId:outS.orderId,orderType:outS.orderType,lineIdx:outS.lineIdx}:null;
  const ok=await applyTransfers(revType,[{out:revOut,in:revIn,qty:num(t.qty)}],{reverseOf:t.id,remark:t.remark||''});
  if(!ok){alert('冲销失败：关联订单/明细不可用');return;}
  t.reversed=true;
  logOp('冲销','调拨台账','冲销调拨记录 '+t.id+'（'+esc(TR_TYPE_LABEL[t.type]||t.type)+' → '+esc(TR_TYPE_LABEL[revType]||revType)+'）');
  renderContent();
  clearGhostSel([outS.orderId,inS.orderId]);
}

/* 调拨台账：只读流水，逐条可冲销
   .115：方向模型——调出订单/调入订单 列 + 类型（调用/退回/改装/移库/改装退回/移库退回）
   trSnapOf 见文件头（快照已存直取，存量反查 in 侧/销售侧兜底） */
function renderTransfers(){
  let rows=(transfers||[]);
  /* 2026-09-06.115：订单「调拨查询」限定=本订单为调出方或调入方的记录（window.transferScopeId 由 queryTransfersOfOrder 设置） */
  const scopeId=window.transferScopeId||null;
  if(scopeId)rows=rows.filter(function(r){
    const _o=trSide(r,'out'),_i=trSide(r,'in');
    return _o.orderId===scopeId||_i.orderId===scopeId;
  });
  TBL_SCHEMAS.transfers=[
    {key:'ts',label:'时间',type:'text'},
    {key:'type',label:'类型',type:'text',select:true,options:TR_TYPE_OPTIONS,get:function(r){return TR_TYPE_LABEL[r.type]||r.type;}},
    /* 2026-10-10.143：单边记录（盘亏/盘盈）缺省侧 orderId 为空串 → 列显示「—」 */
    {key:'outOrderId',label:'调出订单',type:'text',get:function(r){return trSide(r,'out').orderId||'—';}},
    {key:'inOrderId',label:'调入订单',type:'text',get:function(r){return trSide(r,'in').orderId||'—';}},
    {key:'customer',label:'客户',type:'text',get:function(r){return trSnapOf(r).customer;}},
    {key:'contractNo',label:'合同',type:'text',get:function(r){return trSnapOf(r).contractNo;}},
    {key:'productName',label:'商品名称',type:'text',get:function(r){return trSnapOf(r).productName;}},
    {key:'spec',label:'规格',type:'text',get:function(r){return trSnapOf(r).spec;}},
    {key:'model',label:'型号',type:'text',get:function(r){return trSnapOf(r).model;}},
    /* 单边记录调入侧为空 → 回退取调出侧料号（盘亏记录的料号来自调出侧） */
    {key:'productId',label:'产品/料号',type:'text',get:function(r){return trSide(r,'in').productId||trSide(r,'out').productId;}},
    {key:'qty',label:'数量',type:'number'},
    /* 2026-10-10.143：备注列（调整原因）。位置排在「数量」之后、「操作人」之前——
       备注与数量同为本笔调拨的业务属性，紧邻业务字段；操作人属审计字段，保持置末。 */
    {key:'remark',label:'备注',type:'text',get:function(r){return r.remark||'';}},
    {key:'user',label:'操作人',type:'text'}
  ];
  TBL_ROWS.transfers=rows;
  let shown=applyTable('transfers',rows);
  /* 2026-08-25.68：金蝶式分页（单行模型直接切行） */
  if(PAGED_FORMS.transfers&&shown.length>0)shown=slicePaged('transfers',shown,pageSizeOf('transfers')).rows;
  let html='<div class="page">';
  html+='<div class="bulk-bar"><span style="color:var(--muted);font-size:13px">调拨台账：记录「调用 / 退回 / 改装 / 移库 / 盘亏 / 盘盈」及冲销（调出订单 → 调入订单；盘亏/盘盈为单边记录，缺省侧显示「—」）。记录不可修改，仅可逐条冲销。</span>'
    +(scopeId?('<span class="fchip" style="margin-left:8px">仅显示订单 '+esc(scopeId)+' 相关 <b onclick="window.transferScopeId=null;renderContent()" title="移除该限定">×</b></span>'):'')
    +pagerHtml('transfers')+'</div>';
  html+=filterBar('transfers');
  html+='<div class="table-wrap"><table><thead><tr>'
    +TBL_SCHEMAS.transfers.map(function(c){return thCol('transfers',c);}).join('')
    +'<th style="width:80px">操作</th>'
    +'</tr></thead><tbody>';
  /* 空态列数 = 台账列数（13）+ 操作列（1）= 14；新增「备注」列后必须同步（易漏点） */
  if(!shown.length){html+='<tr><td colspan="14" class="empty">'+(scopeId?'该订单暂无调拨记录':'暂无调拨记录')+'</td></tr>';}
  else{
    shown.forEach(function(t){
      const typeCls=TR_TYPE_TAG[t.type]||'tag-gray';
      const outS=trSide(t,'out'),inS=trSide(t,'in');
      const cross=!!(inS.productId&&outS.productId&&String(inS.productId)!==String(outS.productId));
      /* 跨料号（改装/替代调用）：调出侧产品编码 名称 型号/规格 后补（库存订单行优先，产品主数据兜底）。
         2026-10-10.143：单边记录（盘亏/盘盈）调入侧料号为空 → 回退显示调出侧料号；
         cross 判定要求双侧 productId 皆存在，单边记录天然不触发跨料红字提示。 */
      let prodHtml=esc(inS.productId||outS.productId||'');
      if(cross){
        const _oo=orders.find(function(o){return o.id===outS.orderId;});
        const _oit=_oo&&(_oo.items||[])[outS.lineIdx];
        const _ip=products.find(function(p){return p.id===outS.productId;});
        const _nm=(_oit&&_oit.productName)||(_ip?_ip.name:'')||'';
        const _pm=[(_oit&&_oit.model)||(_ip?_ip.model:''),(_oit&&_oit.spec)||(_ip?_ip.spec:'')].filter(Boolean).join(' / ');
        prodHtml+=' <span style="color:var(--red)">←调出 '+esc(outS.productId||'')+(_nm?' '+esc(_nm):'')+(_pm?' ['+esc(_pm)+']':'')+'</span>';
      }
      const btn=t.reversed?'<span style="color:var(--muted)">已冲销</span>'
        :'<button class="btn btn-sm" onclick="reverseTransfer(\''+esc(t.id)+'\')">冲销</button>';
      html+='<tr>'+TBL_SCHEMAS.transfers.map(function(c){
        const v=colVal(c,t);
        let txt;
        if(c.key==='type')txt='<span class="tag '+typeCls+'">'+esc(v||'')+'</span>'+(t.reverseOf?' <span style="color:var(--muted);font-size:11px">(冲销)</span>':'');
        else if(c.key==='productId')txt=prodHtml;   /* 调入产品，含跨料调出提示 */
        else txt=esc(v);
        const st=c.type==='number'?' style="font-variant-numeric:tabular-nums;text-align:right"':'';
        return '<td data-key="'+c.key+'"'+st+'>'+txt+'</td>';
      }).join('')+'<td>'+btn+'</td></tr>';
    });
  }
      html+='</tbody></table></div>';
  html+='</div>';
  return html;
}

/* ================================================================
   2026-09-06.115：库存订单「调用库存」——库存产品从另一种产品库存订单改装/调拨补库
   - 选中 1 张库存订单 A（调入方）→ 弹窗逐明细手填调出源库存订单 B（候选=除 A 自身外全部库存订单行）
   - 跨料号=B 货改装成 A 产品（conv 改装，弹窗红色提示）；同料号=移库（move）
   - 确认：A 行已交付 += qty（补库存）、B 行已交付 −= qty（可超调=源记欠货，同销售调用口径）
     产品主数据库存 Σ(库存订单已交付) 自动联动；写调拨台账（调入订单=A、调出订单=B）
   - 目标量=最大库存量（无则订单数量）；「自动填充」按库存缺口 max(0, 目标量−已交付) 填（手填不设上限，超储由 4 档警示兜底）
   ================================================================ */
var __ivOrder=null,__ivCands=[],__ivLines=[];
function ivPick(li){
  const schema=[
    {key:'invOrderId',label:'库存订单',type:'text'},
    {key:'productId',label:'编码',type:'text'},
    {key:'productName',label:'名称',type:'text'},
    {key:'model',label:'型号',type:'text'},
    {key:'spec',label:'规格',type:'text'},
    {key:'available',label:'可用量',type:'number'}
  ];
  productPickerModal({
    mode:'single',title:'选择调出库存订单',clickSelect:true,   /* 点击行直接选中（立即确认回填，同销售调用弹窗） */
    rows:__ivCands,schema:schema,
    onConfirm:function(ids){
      const c=ids&&ids.length?__ivCands.find(function(x){return x.uid===ids[0];}):null;
      ivSet(li,c||null);
    }
  });
}
/* 回填选择框：显示 库存订单号 · 编码 名称 [型号 / 规格] 可用 N */
function ivSet(li,c){
  const box=document.querySelector('.iv-inv-box[data-li="'+li+'"]');
  if(!box)return;
  box.dataset.ci=c?String(__ivCands.indexOf(c)):'';
  box.innerHTML=c
    ?('<b>'+esc(c.invOrderId)+'</b> · '+esc(c.productId||'')+(c.productName?' '+esc(c.productName):'')+((c.model||c.spec)?' ['+esc([c.model,c.spec].filter(Boolean).join(' / '))+']':'')+' <span style="color:var(--muted)">可用'+c.available+'</span>')
    :'<span style="color:var(--muted)">（不调用）</span>';
  ivWarn(li);
}
function ivClear(li){ivSet(li,null);}
function ivWarn(li){
  const box=document.querySelector('.iv-inv-box[data-li="'+li+'"]');
  const warn=document.querySelector('.iv-warn[data-li="'+li+'"]');
  if(!box)return;
  const ci=box.dataset.ci===''?-1:Number(box.dataset.ci);
  if(ci<0){if(warn)warn.textContent='';return;}
  const c=__ivCands[ci];
  const line=__ivLines.find(function(l){return l.i===li;});
  if(!c||!line)return;
  if(String(c.productId)===String(line.productId)){if(warn)warn.textContent='同料号移库（不改装）';}
  else if(warn)warn.textContent='⚠ 改装：将用【'+esc(c.productId)+'】改装成【'+esc(line.productId)+'】补库';
}
/* 自动填充：每行按库存缺口 max(0, 目标量−已交付)（目标量=最大库存量，无则订单数量；.92 口径） */
function ivAutoFill(){
  if(!__ivLines)return;
  document.querySelectorAll('.iv-qty').forEach(function(inp){
    const li=Number(inp.dataset.li);
    const line=__ivLines.find(function(l){return l.i===li;});
    if(!line){inp.value=0;return;}
    inp.value=Math.max(0,line.gap);
    ivWarn(li);
  });
}
function openInvCallStock(){
  if(!needAct('order_inv.invCall'))return;   /* .119：动作键 invCall（默认 PMC） */
  const s=selSet('order_inv');
  if(s.size===0){alert('请先勾选 1 张库存订单');return;}
  if(s.size>1){alert('「调用库存」只能选择 1 张库存订单，当前已选 '+s.size+' 张。');return;}
  const o=orders[Number([...s][0])];
  if(!o){alert('未找到订单');return;}
  if(orderTypeOf(o)!=='库存订单'){alert('「调用库存」仅适用于库存订单');return;}
  if(o.status==='已取消'||o.status==='已暂停'){alert('订单「'+o.id+'」已'+o.status+'，无法调用库存');return;}
  /* 全部明细行可手填（2026-09-06 用户拍板 C：全部行手填）；目标量=最大库存量（无则订单数量） */
  const lines=(o.items||[]).map(function(it,i){
    const target=invQtyOf(o,it);
    return {i:i,productId:it.productId,productName:it.productName,spec:it.spec||'',model:it.model||'',target:target,deliveredQty:num(it.deliveredQty),gap:target-num(it.deliveredQty)};
  });
  if(!lines.length){alert('该库存订单无明细行');return;}
  const prodMap={};products.forEach(function(p){prodMap[p.id]=p;});
  const cands=[];
  orders.forEach(function(inv){
    if(orderTypeOf(inv)!=='库存订单')return;
    if(inv.id===o.id)return;   /* 排除自身（同单互调无业务意义） */
    (inv.items||[]).forEach(function(it,ii){
      const prod=prodMap[it.productId]||{};
      cands.push({uid:inv.id+'#'+ii,invOrderId:inv.id,invLineIdx:ii,productId:it.productId,productName:it.productName,available:num(it.deliveredQty),spec:it.spec||prod.spec||'',model:it.model||prod.model||''});
    });
  });
  if(!cands.length){alert('没有其他库存订单可作为调用源');return;}
  __ivOrder=o;__ivCands=cands;__ivLines=lines;
  let rows='';
  lines.forEach(function(l){
    const pm=[l.model,l.spec].filter(Boolean).join(' / ');
    let def=cands.filter(function(c){return c.productId===l.productId;}).sort(function(a,b){return b.available-a.available;})[0];
    const boxHtml=def?('<b>'+esc(def.invOrderId)+'</b> · '+esc(def.productId||'')+(def.productName?' '+esc(def.productName):'')+((def.model||def.spec)?' ['+esc([def.model,def.spec].filter(Boolean).join(' / '))+']':'')+' <span style="color:var(--muted)">可用'+def.available+'</span>')
      :'<span style="color:var(--muted)">（不调用）</span>';
    rows+='<tr data-li="'+l.i+'"><td>'+esc(l.productName||l.productId)+'<br><span style="color:var(--muted);font-size:12px">'+esc(l.productId)+(pm?' ['+esc(pm)+']':'')+' 已交付 '+l.deliveredQty+(l.target!=null?' / 目标 '+l.target:'')+'</span></td>'
      +'<td style="min-width:260px"><div class="iv-inv-box" data-li="'+l.i+'" data-ci="'+(def?cands.indexOf(def):'')+'" style="background:var(--bg2,transparent);border:1px solid #d1d5db;border-radius:6px;padding:4px 8px;font-size:12px;margin-bottom:4px">'+boxHtml+'</div>'
      +'<div style="display:flex;gap:4px"><button class="btn btn-sm" onclick="ivPick('+l.i+')">选择</button>'
      +'<button class="btn btn-sm" onclick="ivClear('+l.i+')">清除</button></div>'
      +'<div class="iv-warn" data-li="'+l.i+'" style="color:var(--red);font-size:12px"></div></td>'
      +'<td><input type="number" class="iv-qty" data-li="'+l.i+'" min="0" value="0" style="width:90px"></td></tr>';
  });
  const body='<p style="color:var(--muted);font-size:13px">为「'+esc(o.id)+'」的每条明细选择调出库存订单补库：跨料号=【改装】（源货改装成目标产品）、同料号=【移库】。确认后调入行已交付增加、源行已交付扣减（可超调=源记欠货）。数量手填不限，超目标量将按库存上下限警示。</p>'
    +'<div class="table-wrap"><table><thead><tr><th>库存明细</th><th>调出库存订单</th><th>调用数量</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  showModal('调用库存 - '+esc(o.id),body,
    '<button class="btn" onclick="ivAutoFill()" title="按每行库存缺口（目标量−已交付）自动填充">自动填充</button>'+
    '<button class="btn btn-primary" onclick="doInvCallStock()">确认调用</button>'+
    '<button class="btn" onclick="closeModal()">取消</button>');
  document.querySelectorAll('.iv-inv-box').forEach(function(box){ivWarn(Number(box.dataset.li));});
}
/* 【P1 事务化】同上：async + await */
async function doInvCallStock(){
  if(!__ivOrder){alert('调用上下文丢失，请重新操作');return;}
  const els=document.querySelectorAll('.iv-qty');
  if(!els.length){alert('弹窗已关闭，请重新操作');return;}
  const moves=[];let any=false;let err=null;
  els.forEach(function(inp){
    const li=Number(inp.dataset.li);
    const q=num(inp.value);
    if(q<0){err='调用数量不可为负';return;}
    if(q<=0)return;
    const box=document.querySelector('.iv-inv-box[data-li="'+li+'"]');
    const ci=box?(box.dataset.ci===''?-1:Number(box.dataset.ci)):-1;
    if(ci<0){err='第'+(li+1)+'行未选择调出库存订单';return;}
    const c=__ivCands[ci];
    const line=__ivLines.find(function(l){return l.i===li;});
    if(!c||!line)return;
    /* 跨料号=改装(conv)、同料号=移库(move)（自动判定，2026-09-06 用户拍板 D） */
    const type=String(c.productId)===String(line.productId)?'move':'conv';
    moves.push({out:{orderId:c.invOrderId,orderType:'inv',lineIdx:c.invLineIdx},in:{orderId:__ivOrder.id,orderType:'inv',lineIdx:li},qty:q,type:type});
    any=true;
  });
  if(err){alert(err);return;}
  if(!any){alert('未填写任何调用数量');return;}
  const convs=moves.filter(function(m){return m.type==='conv';}).length;
  const mvs=moves.length-convs;
  if(await applyTransfers(null,moves)){
    logOp('调用库存','库存管理','库存订单 '+__ivOrder.id+' 调用库存补库'+(convs?('（改装 '+convs+' 行'+(mvs?'、移库 '+mvs+' 行':'')+'）'):(mvs?'（移库 '+mvs+' 行）':'')));
    renderContent();
    clearGhostSel(moves.map(function(mv){return mv.out.orderId;}).concat([__ivOrder.id]));
  }else{
    alertTransferFailed();
  }
  closeModal();
}

/* ================================================================
   2026-10-10.143：库存管理「库存调整」（盘盈 / 盘亏）——按明细行调整库存订单已交付
   - 入口：库存管理页勾选 1 张库存订单 → 「库存调整」（动作键 order_inv.invAdjust）
   - 弹窗列出该订单**全部明细行**，每行独立选「盘亏 / 盘盈」+ 填数量（填 0 的行不动）
   - 盘亏（adjust_out）= 该行已交付 − qty（可为负 = 欠货）；盘盈（adjust_in）= 该行已交付 + qty
   - 可选「调整原因」→ 写入台账 remark 字段（台账新增「备注」列）
   - 落盘：**委托 applyTransfers 单边 moves**（out 或 in 为 null）——台账流水单一写入器；
     库存投影（Σ库存订单已交付）与订单自动状态由 applyTransfers 内既有的
     recomputeStockFromInvOrders() + recomputeOrderAutoStatus() 联动，本模块**不重复调用**
   - 台账记录可在调拨台账按「调出订单 / 调入订单」追溯，并支持逐条冲销（单边反向亦为单边）
   ================================================================ */
var __iaOrder=null,__iaLines=[];
/* 行内提示：盘亏后预计为负 → 红字「将形成欠货」。仅本行文案，不复制任何可用量口径公式。 */
function iaWarn(li){
  const line=__iaLines.find(function(l){return l.i===li;});
  const warn=document.querySelector('.ia-warn[data-li="'+li+'"]');
  const inp=document.querySelector('.ia-qty[data-li="'+li+'"]');
  const sel=document.querySelector('.ia-dir[data-li="'+li+'"]');
  if(!line||!warn)return;
  const q=inp?num(inp.value):0;
  const dir=sel?sel.value:'out';
  if(dir==='out'&&q>0&&(line.deliveredQty-q)<0){
    warn.textContent='⚠ 本次盘亏后该行已交付为 '+(line.deliveredQty-q)+'，将形成欠货';
  }else{
    warn.textContent='';
  }
}
function openInvAdjust(){
  if(!needAct('order_inv.invAdjust'))return;   /* .143：动作键 invAdjust（默认 PMC） */
  const s=selSet('order_inv');
  if(s.size===0){alert('请先勾选 1 张库存订单');return;}
  if(s.size>1){alert('「库存调整」只能选择 1 张库存订单，当前已选 '+s.size+' 张。');return;}
  const o=orders[Number([...s][0])];
  if(!o){alert('未找到订单');return;}
  if(orderTypeOf(o)!=='库存订单'){alert('「库存调整」仅适用于库存订单');return;}
  if(o.status==='已取消'||o.status==='已暂停'){alert('订单「'+o.id+'」已'+o.status+'，无法库存调整');return;}
  /* 全部明细行可填（对齐 openInvCallStock：全部行手填）；目标量沿用全局唯一口径 invQtyOf */
  const lines=(o.items||[]).map(function(it,i){
    return {i:i,productId:it.productId,productName:it.productName,spec:it.spec||'',model:it.model||'',target:invQtyOf(o,it),deliveredQty:num(it.deliveredQty)};
  });
  if(!lines.length){alert('该库存订单无明细行');return;}
  __iaOrder=o;__iaLines=lines;
  let rows='';
  lines.forEach(function(l){
    const pm=[l.model,l.spec].filter(Boolean).join(' / ');
    rows+='<tr data-li="'+l.i+'"><td>'+esc(l.productName||l.productId)+'<br><span style="color:var(--muted);font-size:12px">'+esc(l.productId)+(pm?' ['+esc(pm)+']':'')+' 已交付 '+l.deliveredQty+(l.target!=null?' / 目标 '+l.target:'')+'</span></td>'
      +'<td><select class="ia-dir" data-li="'+l.i+'" style="width:88px" onchange="iaWarn('+l.i+')"><option value="out">盘亏</option><option value="in">盘盈</option></select></td>'
      +'<td><input type="number" class="ia-qty" data-li="'+l.i+'" min="0" value="0" style="width:90px" oninput="iaWarn('+l.i+')"></td>'
      +'<td><div class="ia-warn" data-li="'+l.i+'" style="color:var(--red);font-size:12px"></div></td></tr>';
  });
  const body='<p style="color:var(--muted);font-size:13px">为「'+esc(o.id)+'」的每条明细做盘点调整：<b>盘亏</b>=减少该行已交付（可为负，形成欠货）、<b>盘盈</b>=增加该行已交付；数量填 <b>0</b> 的行不做调整。调整会写入调拨台账（盘亏 adjust_out / 盘盈 adjust_in），可在台账按本订单追溯并逐条冲销；库存数量与订单状态会自动联动。</p>'
    +'<div class="form-row"><div><label>调整原因（选填，写入台账备注）</label><input type="text" id="iaRemark" placeholder="如：盘点差异 / 损坏报废 / 找料补录" style="width:100%"></div></div>'
    +'<div class="table-wrap"><table><thead><tr><th>库存明细</th><th>调整方向</th><th>调整数量</th><th>提示</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  showModal('库存调整 - '+esc(o.id),body,
    '<button class="btn btn-primary" onclick="doInvAdjust()">确认调整</button>'+
    '<button class="btn" onclick="closeModal()">取消</button>');
}
/* 【P1 事务化】同上：async + await（等待 applyTransfers 一次 /api/tx 落盘后再报成功） */
async function doInvAdjust(){
  if(!__iaOrder){alert('调整上下文丢失，请重新操作');return;}
  const els=document.querySelectorAll('.ia-qty');
  if(!els.length){alert('弹窗已关闭，请重新操作');return;}
  const rmEl=document.getElementById('iaRemark');
  const rm=rmEl?String(rmEl.value||'').trim():'';
  const moves=[];let any=false;let err=null;
  els.forEach(function(inp){
    const li=Number(inp.dataset.li);
    const q=num(inp.value);
    if(q<0){err='第'+(li+1)+'行调整数量不可为负';return;}
    if(q<=0)return;   /* 填 0 的行不动 */
    const line=__iaLines.find(function(l){return l.i===li;});
    if(!line)return;
    const sel=document.querySelector('.ia-dir[data-li="'+li+'"]');
    const dir=sel?sel.value:'out';
    /* 单边 moves：盘亏=仅 out（已交付减）、盘盈=仅 in（已交付加）；缺省侧传 null。
       台账 qty 恒正，方向由 type 表达（adjust_out / adjust_in）。数量手填不设上限（盘点差异）。 */
    if(dir==='in'){
      moves.push({out:null,in:{orderId:__iaOrder.id,orderType:'inv',lineIdx:li},qty:q,type:'adjust_in',remark:rm});
    }else{
      moves.push({out:{orderId:__iaOrder.id,orderType:'inv',lineIdx:li},in:null,qty:q,type:'adjust_out',remark:rm});
    }
    any=true;
  });
  if(err){alert(err);return;}
  if(!any){alert('未填写任何调整数量');return;}
  const outs=moves.filter(function(m){return m.type==='adjust_out';}).length;
  const ins=moves.length-outs;
  if(await applyTransfers(null,moves)){
    logOp('库存调整','库存管理','库存订单 '+__iaOrder.id+' 库存调整'+(outs?('（盘亏 '+outs+' 行'+(ins?'、盘盈 '+ins+' 行':'')+'）'):(ins?'（盘盈 '+ins+' 行）':'')));
    renderContent();
    clearGhostSel([__iaOrder.id]);
  }else{
    alertTransferFailed();
  }
  closeModal();
}
