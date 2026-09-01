/* 2026-09-01 架构拆分批次5a：调拨模块（调用库存/退回库存/冲销/调拨台账）
   依赖全局（留在 index.html）：productPickerModal/orders/products/transfers/save/DB.set/
   syncStockFromInvOrders/syncOrderAutoStatus/logOp/canWriteKey/num/esc/showModal/closeModal/
   renderContent/clearHiddenOrderSel/orderRowVisibleInDom/TBL_SCHEMAS/TBL_ROWS/applyTable/
   slicePaged/pageSizeOf/pagerHtml/filterBar/thCol/colVal/currentUser
   外部引用：onclick="csPickInv(...)/openCallStock(...)/openReturnStock(...)/reverseTransfer(...)"
   运行时调用本模块全局函数 */
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
  const used={};const invUpdates=[];const salesUpdates=[];let any=false;
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
    used[ci]=(used[ci]||0)+q;
    invUpdates.push({invOrderId:c.invOrderId,invLineIdx:c.invLineIdx,qty:q});
    salesUpdates.push({lineIdx:li,qty:q});
    any=true;
  });
  if(!any){alert('未填写任何调用数量');return;}
  applyStockMove(o,salesUpdates,invUpdates,'call');
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
  const invUpdates=[];const salesUpdates=[];let any=false;
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
    invUpdates.push({invOrderId:c.invOrderId,invLineIdx:c.invLineIdx,qty:q});
    salesUpdates.push({lineIdx:li,qty:q});
    any=true;
  });
  if(!any){alert('未填写任何退回数量');return;}
  applyStockMove(o,salesUpdates,invUpdates,'return');
  closeModal();
}
function applyStockMove(salesOrder,salesUpdates,invUpdates,type){
  invUpdates.forEach(function(u){
    const inv=orders.find(function(x){return x.id===u.invOrderId;});
    if(!inv)return;
    const it=(inv.items||[])[u.invLineIdx];
    if(!it)return;
    const delta=type==='call'?-u.qty:u.qty;
    /* 2026-08-25.20：库存订单已交付允许负数（调用超量=欠货，如 30-50=-20）；退回使负值向 0 恢复 */
    it.deliveredQty=num(it.deliveredQty)+delta;
  });
  salesUpdates.forEach(function(u){
    const it=(salesOrder.items||[])[u.lineIdx];
    if(!it)return;
    const delta=type==='call'?u.qty:-u.qty;
    /* .97 迁移：销售订单已交付改由「交付/退货」操作驱动——调用/退回库存不再自动增减已交付，仅更新 calledQty（可交付上限=已调用累计） */
    it.calledQty=Math.max(0,num(it.calledQty)+delta);
  });
  save('orders',orders);
  syncStockFromInvOrders();
  syncOrderAutoStatus();   // 2026-08-25.3：调拨后按未交付合计自动判定状态（全部交付→已完成 / 未交付>0→执行中）
  const ts=new Date().toLocaleString('zh-CN',{hour12:false});
  const user=(currentUser&&currentUser.name)||(currentUser&&currentUser.username)||'未知';
  salesUpdates.forEach(function(su,idx){
    const iu=invUpdates[idx];
    const inv=orders.find(function(x){return x.id===iu.invOrderId;});
    const invIt=(inv.items||[])[iu.invLineIdx];
    const salesIt=(salesOrder.items||[])[su.lineIdx];
    transfers.unshift({
      id:'TR'+Date.now()+'-'+idx, type:type,
      salesOrderId:salesOrder.id, salesLineIdx:su.lineIdx,
      invOrderId:iu.invOrderId, invLineIdx:iu.invLineIdx,
      productId:salesIt?salesIt.productId:null, invProductId:invIt?invIt.productId:null,
      qty:su.qty, ts:ts, user:user, reversed:false, reverseOf:null,
      /* 2026-08-25.49：台账快照 客户/合同/商品名称/规格/型号（历史记录不随订单后续编辑变化；存量单渲染反查兜底） */
      customer:salesOrder.customer||'', contractNo:salesOrder.contractNo||'',
      productName:salesIt?(salesIt.productName||''):'',
      spec:salesIt?(salesIt.spec||''):'', model:salesIt?(salesIt.model||''):''
    });
  });
  DB.set('transfers',transfers,true).then(function(ok){
    if(ok===false)alert('调拨台账保存失败：订单库存变更已生效，但台账记录未保存，请刷新后核对调拨台账。');
  });
  logOp(type==='call'?'调用库存':'退回库存','订单管理','销售订单 '+salesOrder.id+(type==='call'?' 调用库存':' 退回库存'));
  renderContent();
  /* 2026-08-25.5：状态自动变化后（如全部交付→已完成）若订单被筛选隐藏，清理幽灵勾选（此时 DOM 已按新状态渲染） */
  const _sid=orders.findIndex(function(x){return x.id===salesOrder.id;});
  if(_sid>=0&&!orderRowVisibleInDom(salesOrder.id))clearHiddenOrderSel(_sid);
  invUpdates.forEach(function(u){
    const _ix=orders.findIndex(function(x){return x.id===u.invOrderId;});
    if(_ix>=0&&!orderRowVisibleInDom(orders[_ix].id))clearHiddenOrderSel(_ix);
  });
}
function reverseTransfer(id){
  if(!canWriteKey('transfers')){alert('当前账号无调拨台账编辑权限');return;}
  const t=transfers.find(function(x){return x.id===id;});
  if(!t){alert('未找到记录');return;}
  if(t.reversed){alert('该记录已冲销');return;}
  if(!confirm('确认冲销该调拨记录？将生成一条反向记录。'))return;
  const sales=orders.find(function(x){return x.id===t.salesOrderId;});
  const inv=orders.find(function(x){return x.id===t.invOrderId;});
  if(!sales||!inv){alert('关联订单已不存在，无法冲销');return;}
  const salesIt=(sales.items||[])[t.salesLineIdx];
  const invIt=(inv.items||[])[t.invLineIdx];
  if(!salesIt||!invIt){alert('关联明细已不存在，无法冲销');return;}
  const revType=t.type==='call'?'return':'call';
  /* 2026-08-25.20：库存订单已交付允许负数（冲销时负欠货向 0 恢复）
     .97 迁移：销售订单已交付不再随调拨冲销变动（由交付/退货操作驱动）——冲销只回滚库存订单已交付与销售 calledQty */
  invIt.deliveredQty=num(invIt.deliveredQty)+(t.type==='call'?t.qty:-t.qty);
  /* 2026-08-25.35：已调用同步冲销（冲销 call → 减、冲销 return → 加，下限 0） */
  salesIt.calledQty=Math.max(0,num(salesIt.calledQty)+(t.type==='call'?-t.qty:+t.qty));
  save('orders',orders);
  syncStockFromInvOrders();
  syncOrderAutoStatus();   // 2026-08-25.3：冲销后按未交付合计自动判定状态
  t.reversed=true;
  transfers.unshift({
    id:'TR'+Date.now(), type:revType,
    salesOrderId:t.salesOrderId, salesLineIdx:t.salesLineIdx,
    invOrderId:t.invOrderId, invLineIdx:t.invLineIdx,
    productId:t.productId, invProductId:t.invProductId,
    qty:t.qty, ts:new Date().toLocaleString('zh-CN',{hour12:false}),
    user:(currentUser&&currentUser.name)||'未知', reversed:false, reverseOf:t.id,
    /* 2026-08-25.49：冲销单复制原单快照（存量原单无快照 → 空，渲染反查兜底） */
    customer:t.customer||'', contractNo:t.contractNo||'',
    productName:t.productName||'', spec:t.spec||'', model:t.model||''
  });
  DB.set('transfers',transfers,true).then(function(ok){
    if(ok===false)alert('调拨台账保存失败：冲销已生效，但台账记录未保存，请刷新后核对调拨台账。');
  });
  logOp('冲销','调拨台账','冲销调拨记录 '+t.id);
  renderContent();
  /* 2026-08-25.5：冲销后状态可能自动变化，清理被筛选隐藏订单的幽灵勾选 */
  const _sid2=orders.findIndex(function(x){return x.id===t.salesOrderId;});
  if(_sid2>=0&&!orderRowVisibleInDom(orders[_sid2].id))clearHiddenOrderSel(_sid2);
  const _iid2=orders.findIndex(function(x){return x.id===t.invOrderId;});
  if(_iid2>=0&&!orderRowVisibleInDom(orders[_iid2].id))clearHiddenOrderSel(_iid2);
}

/* 调拨台账：只读流水，逐条可冲销 */
/* 2026-08-25.49：调拨单 客户/合同/商品名称/规格/型号 —— 已快照直接取；存量无快照反查订单兜底 */
function trSnapshot(t){
  if(!t)return {customer:'',contractNo:'',productName:'',spec:'',model:''};
  if(t.customer!=null&&t.productName!=null)return t;
  const o=orders.find(x=>x.id===t.salesOrderId);
  const it=o&&(o.items||[])[t.salesLineIdx];
  return {
    customer:o?(o.customer||''):'', contractNo:o?(o.contractNo||''):'',
    productName:it?(it.productName||it.productId||''):'',
    spec:it?(it.spec||''):'', model:it?(it.model||''):''
  };
}
/* 2026-08-25.49：调拨台账改可筛选结构（TBL_SCHEMAS + thCol 表头 + filterBar + applyTable）；
   保留行内「冲销」按钮；金蝶式筛选随 ENHANCED_FILT_MODES.transfers 生效 */
function renderTransfers(){
  TBL_SCHEMAS.transfers=[
    {key:'ts',label:'时间',type:'text'},
    {key:'type',label:'类型',type:'text',select:true,options:['调用','退回'],get:r=>r.type==='call'?'调用':'退回'},
    {key:'salesOrderId',label:'销售订单',type:'text'},
    {key:'invOrderId',label:'库存订单',type:'text'},
    {key:'customer',label:'客户',type:'text',get:r=>trSnapshot(r).customer},
    {key:'contractNo',label:'合同',type:'text',get:r=>trSnapshot(r).contractNo},
    {key:'productName',label:'商品名称',type:'text',get:r=>trSnapshot(r).productName},
    {key:'spec',label:'规格',type:'text',get:r=>trSnapshot(r).spec},
    {key:'model',label:'型号',type:'text',get:r=>trSnapshot(r).model},
    {key:'productId',label:'产品/料号',type:'text'},
    {key:'qty',label:'数量',type:'number'},
    {key:'user',label:'操作人',type:'text'}
  ];
  TBL_ROWS.transfers=transfers||[];
  let shown=applyTable('transfers',TBL_ROWS.transfers);
  /* 2026-08-25.68：金蝶式分页（单行模型直接切行） */
  if(PAGED_FORMS.transfers&&shown.length>0)shown=slicePaged('transfers',shown,pageSizeOf('transfers')).rows;
  let html='<div class="page">';
  html+='<div class="bulk-bar"><span style="color:var(--muted);font-size:13px">调拨台账：记录每次「调用库存 / 退回库存」及冲销。记录不可修改，仅可逐条冲销。</span>'+pagerHtml('transfers')+'</div>';
  html+=filterBar('transfers');
  html+='<div class="table-wrap"><table><thead><tr>'
    +TBL_SCHEMAS.transfers.map(c=>thCol('transfers',c)).join('')
    +'<th style="width:80px">操作</th>'
    +'</tr></thead><tbody>';
  if(!shown.length){html+='<tr><td colspan="13" class="empty">暂无调拨记录</td></tr>';}
  else{
    shown.forEach(function(t){
      const isCall=t.type==='call';
      const typeCls=isCall?'tag-green':'tag-amber';
      const cross=t.invProductId&&t.productId&&t.invProductId!==t.productId;
      /* 2026-08-25.50：替代产品编码后补 名称/型号/规格（库存订单行优先，产品主数据兜底，格式同调用库存弹窗 [型号 / 规格]） */
      let prodHtml=esc(t.productId||'');
      if(cross){
        const _io=orders.find(function(o){return o.id===t.invOrderId;});
        const _iit=_io&&(_io.items||[])[t.invLineIdx];
        const _ii=(_iit&&String(_iit.productId)===String(t.invProductId))?_iit:null;   /* 订单行编码须与替代编码一致，否则走主数据兜底 */
        const _ip=products.find(function(p){return p.id===t.invProductId;});
        const _nm=(_ii&&_ii.productName)||(_ip?_ip.name:_ip?_ip.id:'')||'';
        const _pm=[(_ii&&_ii.model)||(_ip?_ip.model:''),(_ii&&_ii.spec)||(_ip?_ip.spec:'')].filter(Boolean).join(' / ');
        prodHtml+=' <span style="color:var(--red)">←替代 '+esc(t.invProductId||'')+(_nm?' '+esc(_nm):'')+(_pm?' ['+esc(_pm)+']':'')+'</span>';
      }
      const btn=t.reversed?'<span style="color:var(--muted)">已冲销</span>'
        :'<button class="btn btn-sm" onclick="reverseTransfer(\''+esc(t.id)+'\')">冲销</button>';
      html+='<tr>'+TBL_SCHEMAS.transfers.map(function(c){
        const v=colVal(c,t);
        let txt;
        if(c.key==='type')txt='<span class="tag '+typeCls+'">'+(v||'')+'</span>';
        else if(c.key==='productId')txt=prodHtml;   /* 含替代料提示 */
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
