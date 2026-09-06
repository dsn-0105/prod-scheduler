/* 2026-09-01 架构拆分批次5a：调拨模块（调用库存/退回库存/冲销/调拨台账）
   依赖全局（留在 index.html）：productPickerModal/orders/products/transfers/save/DB.set/
   syncStockFromInvOrders/syncOrderAutoStatus/logOp/canWriteKey/num/esc/showModal/closeModal/
   renderContent/clearHiddenOrderSel/orderRowVisibleInDom/TBL_SCHEMAS/TBL_ROWS/applyTable/
   slicePaged/pageSizeOf/pagerHtml/filterBar/thCol/colVal/currentUser/invQtyOf
   外部引用：onclick="csPickInv(...)/openCallStock(...)/openReturnStock(...)/reverseTransfer(...)/openInvCallStock(...)"
   运行时调用本模块全局函数
   2026-09-06.115：调拨方向模型（见下） */
/* ================================================================
   调拨方向模型（2026-09-06.115）
   - 台账字段从「销售订单/库存订单」（订单类型语义）改为「调出订单/调入订单」（方向语义）：
     out*=调出方（货物流出）、in*=调入方（货物流入），各自携带订单类型与明细行号。
   - 类型语义：call=销售调用库存（库存→销售）/ return=退回（销售→库存，也是 call 的冲销形）/
     conv=改装补库（库存→库存·跨料号）/ move=移库（库存→库存·同料号）；
     冲销反向：call↔return、conv→conv_back（改装退回）、move→move_back（移库退回）
   - 存量旧结构记录（salesOrderId/invOrderId/productId/invProductId…）经一次性数据迁移转新结构；
     trSide/trSnapOf 保留旧结构推导做防御兜底（渲染/冲销兼容未迁移记录）。
================================================================ */
var TR_TYPE_LABEL={call:'调用',return:'退回',conv:'改装',move:'移库',conv_back:'改装退回',move_back:'移库退回'};
var TR_TYPE_TAG={call:'tag-green',return:'tag-amber',conv:'tag-blue',move:'tag-gray',conv_back:'tag-blue',move_back:'tag-gray'};
var TR_TYPE_OPTIONS=['调用','退回','改装','移库','改装退回','移库退回'];
/* 冲销类型映射：call↔return / conv→conv_back / move→move_back（幂等反向） */
function trRevType(type){
  if(type==='call')return 'return';
  if(type==='return')return 'call';
  if(type==='conv')return 'conv_back';
  if(type==='conv_back')return 'conv';
  if(type==='move')return 'move_back';
  if(type==='move_back')return 'move';
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
/* 2026-08-25.51：打开库存订单选择弹窗（单选，复用 productPickerModal 参数化版，列表可筛选） */
function csPickInv(li){
  const schema=[
    {key:'invOrderId',label:'库存订单',type:'text'},
    {key:'productId',label:'编码',type:'text'},
    {key:'productName',label:'名称',type:'text'},
    {key:'model',label:'型号',type:'text'},
    {key:'spec',label:'规格',type:'text'},
    {key:'available',label:'可用量',type:'number'}
  ];
  productPickerModal({
    mode:'single', title:'选择库存订单', clickSelect:true,   /* 2026-08-29.84：点击行直接选中（立即确认回填） */
    rows:__csCands, schema:schema,
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
    /* 2026-08-25.20：调用数量上限=销售未交付（放开库存可用量，可超调=欠货）；退回上限=销售已交付 */
    const max=__csMode==='call'?(line.orderQty-line.deliveredQty):line.deliveredQty;
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
    const cap=__csMode==='call'?(line.orderQty-line.deliveredQty):line.deliveredQty;
    const curAvail=c.available-(used[ci]||0);
    const q=Math.max(0,Math.min(curAvail,cap));
    used[ci]=(used[ci]||0)+q;
    inp.value=q;
  });
  document.querySelectorAll('.cs-qty').forEach(function(inp){csWarn(Number(inp.dataset.li));});
}
/* 2026-08-25.57：自动填充展开框——按库存可用量（原逻辑）/ 按订单数量（全部行填未交付） */
function csToggleFillMenu(btn){
  const old=document.getElementById('csFillMenu');
  if(old){old.remove();return;}
  const m=document.createElement('div');
  m.id='csFillMenu';
  m.style.cssText='position:fixed;z-index:260;background:var(--bg,#fff);border:1px solid #d1d5db;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.12);min-width:150px;padding:4px;font-size:13px';
  m.innerHTML='<div class="cs-fill-opt" style="padding:6px 10px;cursor:pointer;border-radius:4px" onmouseover="this.style.background=\'rgba(0,0,0,.06)\'" onmouseout="this.style.background=\'\'" onclick="csAutoFill();csToggleFillMenu()">按库存可用量填充</div>'
    +'<div class="cs-fill-opt" style="padding:6px 10px;cursor:pointer;border-radius:4px" onmouseover="this.style.background=\'rgba(0,0,0,.06)\'" onmouseout="this.style.background=\'\'" onclick="csFillByOrder();csToggleFillMenu()">按订单数量填充</div>';
  const r=btn.getBoundingClientRect();
  m.style.left=Math.max(8,r.left)+'px';
  m.style.top=(r.bottom+4)+'px';
  document.body.appendChild(m);
}
/* 按订单数量填充：所有行的调用数量填为该行未交付数量（超库存可用量=欠货，.20 已放开） */
function csFillByOrder(){
  if(!__csLines)return;
  document.querySelectorAll('.cs-qty').forEach(function(inp){
    const li=Number(inp.dataset.li);
    const line=__csLines.find(function(l){return l.i===li;});
    if(!line)return;
    const cap=__csMode==='call'?(line.orderQty-line.deliveredQty):line.deliveredQty;
    inp.value=Math.max(0,cap);
  });
  document.querySelectorAll('.cs-qty').forEach(function(inp){csWarn(Number(inp.dataset.li));});
}
function openCallStock(){
  const s=selSet('order_frame');
  if(s.size===0){alert('请先勾选 1 张销售订单');return;}
  if(s.size>1){alert('「调用库存」只能选择 1 张销售订单，当前已选 '+s.size+' 张。');return;}
  const o=orders[Number([...s][0])];
  if(!o){alert('未找到订单');return;}
  if(orderTypeOf(o)!=='销售订单'){alert('「调用库存」仅适用于销售订单');return;}
  if(o.status==='已取消'||o.status==='已暂停'){alert('订单「'+o.id+'」已'+o.status+'，无法调用库存');return;}
  const lines=(o.items||[]).map(function(it,i){return {i:i,productId:it.productId,productName:it.productName,spec:it.spec||'',model:it.model||'',orderQty:num(it.orderQty),deliveredQty:num(it.deliveredQty)};})
    .filter(function(l){return (l.orderQty-l.deliveredQty)>0;});
  if(!lines.length){alert('该销售订单所有明细均已交付，无可调用库存');return;}
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
    const undel=l.orderQty-l.deliveredQty;
    const pm=[l.model,l.spec].filter(Boolean).join(' / ');
    let def=cands.filter(function(c){return c.productId===l.productId;}).sort(function(a,b){return b.available-a.available;})[0];
    /* 2026-08-25.51：下拉改选择框（单选弹窗+筛选）——显示 编码/名称/型号/规格/可用量，默认预填同料号最大可用 */
    const boxHtml=def?('<b>'+esc(def.invOrderId)+'</b> · '+esc(def.productId||'')+(def.productName?' '+esc(def.productName):'')+((def.model||def.spec)?' ['+esc([def.model,def.spec].filter(Boolean).join(' / '))+']':'')+' <span style="color:var(--muted)">可用'+def.available+'</span>')
      :'<span style="color:var(--muted)">（不调用）</span>';
    rows+='<tr data-li="'+l.i+'"><td>'+esc(l.productName||l.productId)+'<br><span style="color:var(--muted);font-size:12px">'+esc(l.productId)+(pm?' ['+esc(pm)+']':'')+' 未交付 '+undel+'</span></td>'
      +'<td style="min-width:260px"><div class="cs-inv-box" data-li="'+l.i+'" data-ci="'+(def?cands.indexOf(def):'')+'" style="background:var(--bg2,transparent);border:1px solid #d1d5db;border-radius:6px;padding:4px 8px;font-size:12px;margin-bottom:4px">'+boxHtml+'</div>'
      +'<div style="display:flex;gap:4px"><button class="btn btn-sm" onclick="csPickInv('+l.i+')">选择</button>'
      +'<button class="btn btn-sm" onclick="csClearInv('+l.i+')">清除</button></div>'
      +'<div class="cs-warn" data-li="'+l.i+'" style="color:var(--red);font-size:12px"></div></td>'
      +'<td><input type="number" class="cs-qty" data-li="'+l.i+'" min="0" value="0" style="width:90px"></td></tr>';
  });
  const body='<p style="color:var(--muted);font-size:13px">为「'+esc(o.id)+'」的每条明细选择被调用的库存订单（默认同料号，跨料号将提示）。调用数量不可超过销售未交付量；可超出库存可用量，超出部分库存订单记欠货（已交付为负）。</p>'
    +'<div class="table-wrap"><table><thead><tr><th>销售明细</th><th>调用库存订单</th><th>调用数量</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  __csOrder=o;
  showModal('调用库存 - '+esc(o.id),body,
    /* 2026-08-25.57：自动填充 + 右侧展开框（按库存可用量 / 按订单数量=填未交付） */
    '<span style="position:relative"><button class="btn" onclick="csAutoFill()">自动填充</button>'+
    '<button class="btn" onclick="csToggleFillMenu(this)" title="更多填充方式" style="padding:2px 7px">▾</button></span>'+
    '<button class="btn btn-primary" onclick="doCallStock(__csOrder)">确认调用</button>'+
    '<button class="btn" onclick="closeModal()">取消</button>');
  csAttach();
}
function doCallStock(o){
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
    const undel=line.orderQty-line.deliveredQty;
    /* 2026-08-25.20：放开「不超过库存可用量」校验（可超调=库存订单记欠货），仅校验不超过销售未交付 */
    if(q>undel){alert('调用数量 '+q+' 超过销售未交付 '+undel);return;}
    moves.push({out:{orderId:c.invOrderId,orderType:'inv',lineIdx:c.invLineIdx},in:{orderId:o.id,orderType:'sales',lineIdx:li},qty:q});
    any=true;
  });
  if(!any){alert('未填写任何调用数量');return;}
  if(applyTransfers('call',moves)){
    logOp('调用库存','订单管理','销售订单 '+o.id+' 调用库存');
    renderContent();
    clearGhostSel(moves.map(function(mv){return mv.out.orderId;}).concat([o.id]));
  }
  closeModal();
}
function openReturnStock(){
  const s=selSet('order_frame');
  if(s.size===0){alert('请先勾选 1 张销售订单');return;}
  if(s.size>1){alert('「退回库存」只能选择 1 张销售订单，当前已选 '+s.size+' 张。');return;}
  const o=orders[Number([...s][0])];
  if(!o){alert('未找到订单');return;}
  if(orderTypeOf(o)!=='销售订单'){alert('「退回库存」仅适用于销售订单');return;}
  if(o.status==='已取消'||o.status==='已暂停'){alert('订单「'+o.id+'」已'+o.status+'，无法退回库存');return;}
  const lines=(o.items||[]).map(function(it,i){return {i:i,productId:it.productId,productName:it.productName,spec:it.spec||'',model:it.model||'',orderQty:num(it.orderQty),deliveredQty:num(it.deliveredQty)};})
    .filter(function(l){return l.deliveredQty>0;});
  if(!lines.length){alert('该销售订单所有明细已交付量为 0，无可供退回的库存');return;}
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
    rows+='<tr data-li="'+l.i+'"><td>'+esc(l.productName||l.productId)+'<br><span style="color:var(--muted);font-size:12px">'+esc(l.productId)+(pm?' ['+esc(pm)+']':'')+' 已交付 '+l.deliveredQty+'</span></td>'
      +'<td style="min-width:260px"><div class="cs-inv-box" data-li="'+l.i+'" data-ci="'+(def?cands.indexOf(def):'')+'" style="background:var(--bg2,transparent);border:1px solid #d1d5db;border-radius:6px;padding:4px 8px;font-size:12px;margin-bottom:4px">'+boxHtml+'</div>'
      +'<div style="display:flex;gap:4px"><button class="btn btn-sm" onclick="csPickInv('+l.i+')">选择</button>'
      +'<button class="btn btn-sm" onclick="csClearInv('+l.i+')">清除</button></div>'
      +'<div class="cs-warn" data-li="'+l.i+'" style="color:var(--red);font-size:12px"></div></td>'
      +'<td><input type="number" class="cs-qty" data-li="'+l.i+'" min="0" max="'+l.deliveredQty+'" value="0" style="width:90px"></td></tr>';
  });
  const body='<p style="color:var(--muted);font-size:13px">为「'+esc(o.id)+'」的每条已交付明细选择退回目标库存订单（默认同料号，跨料号将提示）。退回数量不可超过销售已交付量。</p>'
    +'<div class="table-wrap"><table><thead><tr><th>销售明细</th><th>退回目标库存订单</th><th>退回数量</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  __csOrder=o;
  showModal('退回库存 - '+esc(o.id),body,
    '<button class="btn" onclick="csAutoFill()">自动填充</button>'+
    '<button class="btn btn-primary" onclick="doReturnStock(__csOrder)">确认退回</button>'+
    '<button class="btn" onclick="closeModal()">取消</button>');
  csAttach();
}
function doReturnStock(o){
  const moves=[];let any=false;
  document.querySelectorAll('.cs-qty').forEach(function(inp){
    const li=Number(inp.dataset.li);
    const q=num(inp.value);
    if(q<=0)return;
    const box=document.querySelector('.cs-inv-box[data-li="'+li+'"]');
    const ci=box?(box.dataset.ci===''?-1:Number(box.dataset.ci)):-1;
    if(ci<0){alert('第'+(li+1)+'行未选择库存订单');return;}
    const line=__csLines.find(function(l){return l.i===li;});
    if(q>line.deliveredQty){alert('退回数量 '+q+' 超过销售已交付 '+line.deliveredQty);return;}
    const c=__csCands[ci];
    moves.push({out:{orderId:o.id,orderType:'sales',lineIdx:li},in:{orderId:c.invOrderId,orderType:'inv',lineIdx:c.invLineIdx},qty:q});
    any=true;
  });
  if(!any){alert('未填写任何退回数量');return;}
  if(applyTransfers('return',moves)){
    logOp('退回库存','订单管理','销售订单 '+o.id+' 退回库存');
    renderContent();
    clearGhostSel(moves.map(function(mv){return mv.in.orderId;}).concat([o.id]));
  }
  closeModal();
}
/* ================================================================
   2026-09-06.115：通用调拨执行（方向模型，替代原 applyStockMove 二元模型）
   moves: [{out:{orderId,orderType,lineIdx}, in:{orderId,orderType,lineIdx}, qty}]
   type: call/return/conv/move/conv_back/move_back（conv_back/move_back 供冲销反向）
   opts.reverseOf: 冲销生成记录时指向被冲销的原记录 id
   数量规则（方向语义=货物 out 流向 in）：
     参与方为库存订单 → 明细 deliveredQty（out 减 / in 加，可负=欠货，.20 口径）
     参与方为销售订单 → 明细 calledQty（out 减 / in 加，下限 0；.97 已交付由交付/退货驱动）
   台账快照：参与方含销售订单→取销售侧订单/行（客户/合同/商品名）；纯库存互调→调入侧库存行
   ================================================================ */
function applyTransfers(type,moves,opts){
  if(!moves||!moves.length)return false;
  /* 前置校验：全部参与方订单/明细须存在，任一缺失整批放弃（不改任何数据） */
  for(const mv of moves){
    const oo=orders.find(function(o){return o.id===mv.out.orderId;});
    const oi=orders.find(function(o){return o.id===mv.in.orderId;});
    if(!oo||!oi||!Array.isArray(oo.items)||!Array.isArray(oi.items))return false;
    if(!(oo.items||[])[mv.out.lineIdx]||!(oi.items||[])[mv.in.lineIdx])return false;
  }
  moves.forEach(function(mv){
    const oo=orders.find(function(o){return o.id===mv.out.orderId;});
    const oi=orders.find(function(o){return o.id===mv.in.orderId;});
    const oit=(oo.items||[])[mv.out.lineIdx],iit=(oi.items||[])[mv.in.lineIdx];
    /* 2026-08-25.20：库存订单已交付允许负数（调用超量=欠货）；销售 calledQty 下限 0 */
    if(mv.out.orderType==='inv')oit.deliveredQty=num(oit.deliveredQty)-mv.qty;
    else oit.calledQty=Math.max(0,num(oit.calledQty)-mv.qty);
    if(mv.in.orderType==='inv')iit.deliveredQty=num(iit.deliveredQty)+mv.qty;
    else iit.calledQty=Math.max(0,num(iit.calledQty)+mv.qty);
  });
  save('orders',orders);
  syncStockFromInvOrders();
  syncOrderAutoStatus();   // 2026-08-25.3：调拨后按未交付合计自动判定状态
  const ts=new Date().toLocaleString('zh-CN',{hour12:false});
  const user=(currentUser&&currentUser.name)||(currentUser&&currentUser.username)||'未知';
  moves.forEach(function(mv,idx){
    const oo=orders.find(function(o){return o.id===mv.out.orderId;});
    const oi=orders.find(function(o){return o.id===mv.in.orderId;});
    const oit=(oo.items||[])[mv.out.lineIdx],iit=(oi.items||[])[mv.in.lineIdx];
    const snap=(mv.out.orderType==='sales')?{o:oo,it:oit}:{o:oi,it:iit};   /* 销售侧优先（客户/合同），否则调入侧 */
    transfers.unshift({
      id:'TR'+Date.now()+'-'+idx,type:(mv.type||type),
      outOrderId:mv.out.orderId,outOrderType:mv.out.orderType,outLineIdx:mv.out.lineIdx,outProductId:oit?oit.productId:null,
      inOrderId:mv.in.orderId,inOrderType:mv.in.orderType,inLineIdx:mv.in.lineIdx,inProductId:iit?iit.productId:null,
      qty:mv.qty,ts:ts,user:user,reversed:false,reverseOf:(opts&&opts.reverseOf)||null,
      /* 2026-08-25.49：台账快照（历史记录不随订单后续编辑变化；存量单渲染反查兜底） */
      customer:snap.o?(snap.o.customer||''):'',contractNo:snap.o?(snap.o.contractNo||''):'',
      productName:snap.it?(snap.it.productName||''):'',
      spec:snap.it?(snap.it.spec||''):'',model:snap.it?(snap.it.model||''):''
    });
  });
  DB.set('transfers',transfers,true).then(function(ok){
    if(ok===false)alert('调拨台账保存失败：订单库存变更已生效，但台账记录未保存，请刷新后核对调拨台账。');
  });
  return true;
}
/* 调拨/冲销后清理被筛选隐藏订单的幽灵勾选（2026-08-25.5，此时 DOM 已按新状态渲染） */
function clearGhostSel(orderIds){
  (orderIds||[]).forEach(function(id){
    const ix=orders.findIndex(function(x){return x.id===id;});
    if(ix>=0&&!orderRowVisibleInDom(orders[ix].id))clearHiddenOrderSel(ix);
  });
}
function reverseTransfer(id){
  if(!canWriteKey('transfers')){alert('当前账号无调拨台账编辑权限');return;}
  const t=transfers.find(function(x){return x.id===id;});
  if(!t){alert('未找到记录');return;}
  if(t.reversed){alert('该记录已冲销');return;}
  if(!confirm('确认冲销该调拨记录？将生成一条反向记录。'))return;
  const outS=trSide(t,'out'),inS=trSide(t,'in');
  if(!outS.orderId||!inS.orderId){alert('记录缺少调出/调入方信息，无法冲销');return;}
  const revType=trRevType(t.type);
  if(!revType){alert('未知调拨类型，无法冲销');return;}
  const outO=orders.find(function(x){return x.id===outS.orderId;});
  const inO=orders.find(function(x){return x.id===inS.orderId;});
  if(!outO||!inO){alert('关联订单已不存在，无法冲销');return;}
  const outIt=(outO.items||[])[outS.lineIdx];
  const inIt=(inO.items||[])[inS.lineIdx];
  if(!outIt||!inIt){alert('关联明细已不存在，无法冲销');return;}
  /* 反向执行：原调出方收回、原调入方退回 —— 方向对调（原 out 当 in、原 in 当 out）后数量自动反向滚回。
     .97 口径：销售订单已交付不随调拨变动（由交付/退货操作驱动），仅滚回库存已交付与销售 calledQty。
     .115：conv/move 冲销生成 conv_back/move_back（改装退回/移库退回）反向记录，reverseOf 指向原记录 */
  const ok=applyTransfers(revType,[{out:{orderId:inS.orderId,orderType:inS.orderType,lineIdx:inS.lineIdx},
    in:{orderId:outS.orderId,orderType:outS.orderType,lineIdx:outS.lineIdx},qty:num(t.qty)}],{reverseOf:t.id});
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
    {key:'outOrderId',label:'调出订单',type:'text',get:function(r){return trSide(r,'out').orderId;}},
    {key:'inOrderId',label:'调入订单',type:'text',get:function(r){return trSide(r,'in').orderId;}},
    {key:'customer',label:'客户',type:'text',get:function(r){return trSnapOf(r).customer;}},
    {key:'contractNo',label:'合同',type:'text',get:function(r){return trSnapOf(r).contractNo;}},
    {key:'productName',label:'商品名称',type:'text',get:function(r){return trSnapOf(r).productName;}},
    {key:'spec',label:'规格',type:'text',get:function(r){return trSnapOf(r).spec;}},
    {key:'model',label:'型号',type:'text',get:function(r){return trSnapOf(r).model;}},
    {key:'productId',label:'产品/料号',type:'text',get:function(r){return trSide(r,'in').productId;}},
    {key:'qty',label:'数量',type:'number'},
    {key:'user',label:'操作人',type:'text'}
  ];
  TBL_ROWS.transfers=rows;
  let shown=applyTable('transfers',rows);
  /* 2026-08-25.68：金蝶式分页（单行模型直接切行） */
  if(PAGED_FORMS.transfers&&shown.length>0)shown=slicePaged('transfers',shown,pageSizeOf('transfers')).rows;
  let html='<div class="page">';
  html+='<div class="bulk-bar"><span style="color:var(--muted);font-size:13px">调拨台账：记录「调用 / 退回 / 改装 / 移库」及冲销（调出订单 → 调入订单）。记录不可修改，仅可逐条冲销。</span>'
    +(scopeId?('<span class="fchip" style="margin-left:8px">仅显示订单 '+esc(scopeId)+' 相关 <b onclick="window.transferScopeId=null;renderContent()" title="移除该限定">×</b></span>'):'')
    +pagerHtml('transfers')+'</div>';
  html+=filterBar('transfers');
  html+='<div class="table-wrap"><table><thead><tr>'
    +TBL_SCHEMAS.transfers.map(function(c){return thCol('transfers',c);}).join('')
    +'<th style="width:80px">操作</th>'
    +'</tr></thead><tbody>';
  if(!shown.length){html+='<tr><td colspan="13" class="empty">'+(scopeId?'该订单暂无调拨记录':'暂无调拨记录')+'</td></tr>';}
  else{
    shown.forEach(function(t){
      const typeCls=TR_TYPE_TAG[t.type]||'tag-gray';
      const outS=trSide(t,'out'),inS=trSide(t,'in');
      const cross=!!(inS.productId&&outS.productId&&String(inS.productId)!==String(outS.productId));
      /* 跨料号（改装/替代调用）：调出侧产品编码 名称 型号/规格 后补（库存订单行优先，产品主数据兜底） */
      let prodHtml=esc(inS.productId||'');
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
function doInvCallStock(){
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
  if(applyTransfers(null,moves)){
    logOp('调用库存','库存管理','库存订单 '+__ivOrder.id+' 调用库存补库'+(convs?('（改装 '+convs+' 行'+(mvs?'、移库 '+mvs+' 行':'')+'）'):(mvs?'（移库 '+mvs+' 行）':'')));
    renderContent();
    clearGhostSel(moves.map(function(mv){return mv.out.orderId;}).concat([__ivOrder.id]));
  }
  closeModal();
}
