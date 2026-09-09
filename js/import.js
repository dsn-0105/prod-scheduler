/* 2026-09-01 架构拆分批次3：金蝶导入模块（importXLSX/kdState/kdReport/kd*系列 从 index.html 提取）
   依赖全局：XLSX 库(外部)/orders/fields/save/renderContent/importFormKey(留在 index.html)
   triggerImport(:6270)/formIOBtns 留在 index.html 运行时调用本模块全局函数 */
function importXLSX(e){
  var file=e.target.files[0];
  if(!file){importFormKey='';return;}
  var reader=new FileReader();
  reader.onload=async function(){
    try{
      var sheets=await XLSX.parse(reader.result);
      if(importFormKey){
        /* 单表单导入 */
        var cfg=XLSX_SHEETS.find(function(c){return c.formKey===importFormKey;});
        if(!cfg){alert('未找到对应表单配置');importFormKey='';e.target.value='';return;}
        var sh=sheets[0];
        if(!sh||!sh.headers.length){alert('未识别到有效数据：文件中没有表头行。');importFormKey='';e.target.value='';return;}
        var farr=fields[cfg.formKey]||[];
        var labelToKey={};
        farr.forEach(function(f){labelToKey[f.label]=f.key;});
        var colKeys=sh.headers.map(function(label){return labelToKey[label]||null;});
        if(colKeys.filter(Boolean).length===0){
          alert('未识别到任何匹配的表头字段，导入已取消。\n\n请使用本系统导出的模板，或确认文件表头与「'+cfg.sheet+'」字段一致。');
          importFormKey='';e.target.value='';return;
        }
        var mappedKeys=farr.map(function(f){return f.key;});
        var newData=sh.rows.map(function(row){
          var obj={};
          colKeys.forEach(function(key,c){
            if(key){
              var fdef=farr.find(function(f){return f.key===key;});
              var val=row[c];
              if(fdef&&fdef.type==='number')val=num(val);
              obj[key]=val;
            }
          });
          return obj;
        }).filter(function(obj){return rowHasData(obj,mappedKeys);});
        if(newData.length===0){
          alert('未识别到有效数据（所有数据行均为空或不匹配）。\n\n请确认：文件表头与导出时一致、且数据行不为空。');
          importFormKey='';e.target.value='';return;
        }
        var exist=currentDataCount(cfg.varName);
        if(exist>0){
          if(!confirm('即将导入 '+newData.length+' 条记录到「'+cfg.sheet+'」，\n并覆盖其中现有的 '+exist+' 条记录。\n\n（已自动备份当前数据，可用顶部「恢复」还原）\n此操作不可撤销，确定继续？')){
            importFormKey='';e.target.value='';return;
          }
          importPreBackup();
        }
        if(cfg.formKey==='order')newData=groupOrderRows(newData);
        setDataByVar(cfg.varName,newData);
        save(cfg.varName,newData);
        logOp('导入',cfg.sheet,'导入 '+newData.length+' 条记录到「'+cfg.sheet+'」（覆盖前 '+exist+' 条）');
        renderAll();
        alert('导入成功！共导入 '+newData.length+' 条记录到「'+cfg.sheet+'」。\n\n原有数据已自动备份，可在顶部「恢复」中还原。');
      }else{
        /* 全量导入 */
        var plan=[],totalNew=0;
        for(var si=0;si<sheets.length;si++){
          var sh2=sheets[si];
          var cfg2=XLSX_SHEETS.find(function(c){return c.sheet===sh2.name;});
          if(!cfg2||!sh2.headers.length)continue;
          var farr2=fields[cfg2.formKey]||[];
          var labelToKey2={};
          farr2.forEach(function(f){labelToKey2[f.label]=f.key;});
          var colKeys2=sh2.headers.map(function(label){return labelToKey2[label]||null;});
          if(colKeys2.filter(Boolean).length===0)continue;
          var mappedKeys2=farr2.map(function(f){return f.key;});
          var nd=sh2.rows.map(function(row){
            var obj={};
            colKeys2.forEach(function(key,c){
              if(key){
                var fdef=farr2.find(function(f){return f.key===key;});
                var val=row[c];
                if(fdef&&fdef.type==='number')val=num(val);
                obj[key]=val;
              }
            });
            return obj;
          }).filter(function(obj){return rowHasData(obj,mappedKeys2);});
          if(nd.length>0){
            if(cfg2.formKey==='order')nd=groupOrderRows(nd);
            plan.push({cfg:cfg2,data:nd});
            totalNew+=nd.length;
          }
        }
        if(plan.length===0){alert('未识别到任何有效数据。请确认文件包含正确的 Sheet 名称和表头。');importFormKey='';e.target.value='';return;}
        var existTotal=currentDataCount('products')+currentDataCount('orders')+currentDataCount('deliveries');
        if(existTotal>0){
          var detail=plan.map(function(p){return '「'+p.cfg.sheet+'」'+p.data.length+' 条';}).join('、');
          if(!confirm('即将全量导入，覆盖以下表单数据：\n'+detail+'\n\n当前共有 '+existTotal+' 条记录将被覆盖。\n\n（已自动备份当前数据，可用顶部「恢复」还原）\n此操作不可撤销，确定继续？')){
            importFormKey='';e.target.value='';return;
          }
          importPreBackup();
        }
        plan.forEach(function(p){
          setDataByVar(p.cfg.varName,p.data);
          save(p.cfg.varName,p.data);
          logOp('导入',p.cfg.sheet,'全量导入 '+p.data.length+' 条记录');
        });
        renderAll();
        alert('导入成功！共导入 '+plan.length+' 个表单的数据。\n\n原有数据已自动备份，可在顶部「恢复」中还原。');
      }
    }catch(err){alert('导入失败：'+err.message+'\n\n请确认文件为 .xlsx 格式。');}
    importFormKey='';
    e.target.value='';
  };
  reader.readAsArrayBuffer(file);
}

/* ================================================================
   金蝶 ERP 销售订单 → 销售订单 批量导入
   流程：解析(含合并单元格展开+日期序列转YYYY-MM-DD) → 按单据编号聚合
        → 只读预检 → 预检报告(批量决策) → 确认写入
================================================================ */
var kdState=null;   // 本次导入的决策状态
var kdReport=null;  // 本次导入的预检报告

function triggerImportKingdee(){
  if(!ensureWrite('order_frame'))return;
  if(!needAct('order_frame.kingdeeImport'))return;   /* .119：动作键 kingdeeImport（经理） */
  document.getElementById('importKingdeeFile').click();
}

/* 金蝶表头 → 系统字段映射（按关键字匹配，忽略空白） */
function kdMapHeader(h){
  h=String(h==null?'':h).trim().replace(/\s/g,'');
  if(!h)return null;
  var rules=[
    [/单据编号|单据号|编号/, 'id'],
    [/客户|购货|购方|收货单位/, 'customer'],
    [/单据日期|业务日期|下单日期/, 'startDate'],
    [/预计交货|交货日期|交期|到期日/, 'deadline'],
    [/审核状态|单据状态|状态/, 'status'],
    [/合同|合约/, 'contractNo'],
    [/商品编码|物料编码|产品编码|编码/, 'productId'],
    [/商品名称|物料名称|产品名称|名称/, 'productName'],
    [/规格型号|规格/, 'spec'],
    [/型号/, 'model'],
    [/单位/, 'unit'],
    [/已出库数量|已交付|发货数量|出库数量|行已执行已出库数量/, 'deliveredQty'],
    [/数量|订购数量|订单数量|订货数量/, 'orderQty'],
    [/单价|标准售价|含税单价/, 'price'],
    [/金额|价税合计|价税金额|含税金额|金额合计/, 'amount'],
    [/税额|税金/, 'tax'],
    [/备注|摘要|行备注|商品行备注/, 'lineNotes'],
    [/商品描述|描述|说明/, 'desc'],
    [/业务员|销售员/, 'salesman'],
    [/部门/, 'dept']
  ];
  for(var i=0;i<rules.length;i++){if(rules[i][0].test(h))return rules[i][1];}
  return null;
}
function kdBuildColMap(headers){
  var m={};
  headers.forEach(function(h,c){
    var k=kdMapHeader(h);
    if(k&&m[k]==null)m[k]=c;
  });
  return m;
}
/* Excel 日期序列值(1900日期系统) → YYYY-MM-DD；已是文本日期则规范化 */
function kdExcelSerialToDate(v){
  if(v==null||v==='')return '';
  if(typeof v==='string'){var s=v.trim();var m=/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);if(m)return m[1]+'-'+String(m[2]).padStart(2,'0')+'-'+String(m[3]).padStart(2,'0');return s;}
  var n=Number(v);if(isNaN(n)||n<1)return '';
  var d=new Date(Math.round((n-25569)*86400000));if(isNaN(d.getTime()))return '';
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
/* 按合并单元格向下/向右填充整张网格（金蝶一单多行：单据头在合并区） */
function kdExpandMerges(grid,merges){
  if(!merges||!merges.length)return grid;
  var g=grid.map(function(row){return row.slice();});
  merges.forEach(function(mg){
    if(mg.r1<0||mg.r1>=g.length)return;
    var val=g[mg.r1][mg.c1];
    for(var r=mg.r1;r<=mg.r2;r++){
      if(r<0||r>=g.length)continue;
      for(var c=mg.c1;c<=mg.c2;c++){
        if(c<0||c>=g[r].length)continue;
        g[r][c]=val;
      }
    }
  });
  return g;
}
/* 生成不冲突的新订单号（变更订单号用） */
function kdRenameId(base){
  var i=2, cand=base+'_'+i;
  while(orders.some(function(o){return o.id===cand;})){i++;cand=base+'_'+i;}
  return cand;
}

function importKingdeeXLSX(e){
  var file=e.target.files[0];
  if(!file){e.target.value='';return;}
  var reader=new FileReader();
  reader.onload=async function(){
    try{
      var sheets=await XLSX.parse(reader.result);
      if(!sheets||!sheets.length){alert('未识别到任何工作表');e.target.value='';return;}
      var sh=null;
      for(var si=0;si<sheets.length;si++){if(sheets[si].rows&&sheets[si].rows.length){sh=sheets[si];break;}}
      if(!sh){alert('文件中没有可用数据行');e.target.value='';return;}
      var grid=[sh.headers].concat(sh.rows);
      grid=kdExpandMerges(grid,sh.merges);
      /* 定位表头行（前 6 行内找含"单据编号"的行；兼容金蝶引出带标题行） */
      var hdrIdx=0;
      for(var ri=0;ri<Math.min(6,grid.length);ri++){var km0=kdBuildColMap(grid[ri]);if(km0.id!=null){hdrIdx=ri;break;}}
      var headers=grid[hdrIdx];
      var dataRows=grid.slice(hdrIdx+1);
      var colMap=kdBuildColMap(headers);
      if(colMap.id==null){alert('未识别到"单据编号"列，请确认是金蝶销售订单引出表。');e.target.value='';return;}
      /* 聚合：按单据编号 → 订单 + 多明细行 */
      var pm={};products.forEach(function(p){pm[p.id]=p;});
      var map={},list=[];
      var noOrderId=0;
      dataRows.forEach(function(row){
        var head={};
        ['id','customer','startDate','deadline','contractNo'].forEach(function(k){head[k]=colMap[k]!=null?row[colMap[k]]:'';});
        head.startDate=kdExcelSerialToDate(head.startDate);
        head.deadline=kdExcelSerialToDate(head.deadline);
        var pid=colMap.productId!=null?row[colMap.productId]:'';
        if(!head.id){
          if(pid)noOrderId++;
          return;
        }
        if(!map[head.id]){
          var o={id:head.id,customer:String(head.customer==null?'':head.customer),startDate:head.startDate,deadline:head.deadline,contractNo:String(head.contractNo==null?'':head.contractNo),items:[]};
          map[head.id]=o;list.push(o);
        }
        if(!pid)return; // 该明细行无商品编码，稍后在预检中标记跳过
        var it={};
        ['productId','productName','spec','model','unit','orderQty','deliveredQty','lineNotes','desc'].forEach(function(k){it[k]=colMap[k]!=null?row[colMap[k]]:'';});
        it.orderQty=num(it.orderQty);
        it.deliveredQty=num(it.deliveredQty);
        map[head.id].items.push(it);
      });
      if(list.length===0){alert('未解析到任何订单（请确认存在"单据编号"与"商品编码"列）。');e.target.value='';return;}
      kdPrecheckAndShow(list,pm,file.name,noOrderId);
    }catch(err){alert('金蝶订单导入失败：'+(err&&err.message?err.message:err)+'\n\n请确认文件为 .xlsx 格式，并使用 Chrome 80+。');}
    e.target.value='';
  };
  reader.readAsArrayBuffer(file);
}

/* 预检扫描 + 出报告弹窗 */
function kdPrecheckAndShow(list,pm,filename,noOrderId){
  var orderIds=new Set(orders.map(function(o){return o.id;}));
  var prodKeys=new Set(Object.keys(pm));
  var emptyText=[],dateMissing=[],conflict=[],unknown=[],lineSkip=[];
  list.forEach(function(o){
    if(!o.customer||!String(o.customer).trim())emptyText.push(o);
    if(!o.contractNo||!String(o.contractNo).trim())emptyText.push(o);
    if(!o.startDate||!o.deadline)dateMissing.push(o);
    if(orderIds.has(o.id))conflict.push(o);
    o.items.forEach(function(it,li){
      var pid=String(it.productId==null?'':it.productId).trim();
      if(!pid){lineSkip.push({o:o,li:li});}
      else if(!prodKeys.has(pid))unknown.push({o:o,li:li,pid:pid});
    });
  });
  /* 去重 emptyText（同一订单可能客户+合同号都空） */
  var emptyTextUniq=[],seenE={};emptyText.forEach(function(o){if(!seenE[o.id]){seenE[o.id]=1;emptyTextUniq.push(o);}});
  var totalOrders=list.length;
  var issuesCount=emptyTextUniq.length+dateMissing.length+conflict.length+unknown.length+lineSkip.length;
  var ERR_ABS=50,ERR_PCT=0.30;
  var threshold=Math.max(ERR_ABS,Math.ceil(ERR_PCT*totalOrders));
  unknown.forEach(function(u,i){u.idx=i;});
  conflict.forEach(function(c,i){c.idx=i;});
  var blocked=(dateMissing.length>0)||(issuesCount>threshold);
  kdReport={list:list,pm:pm,filename:filename,noOrderId:noOrderId,
    emptyText:emptyTextUniq,dateMissing:dateMissing,conflict:conflict,unknown:unknown,lineSkip:lineSkip,
    totalOrders:totalOrders,issuesCount:issuesCount,threshold:threshold,blocked:blocked};
  kdState={conflict:{},unknown:{},emptyTextApplied:true};
  kdShowReport();
}

function kdShowReport(){
  var R=kdReport;if(!R)return;
  var body='<div style="font-size:13px;color:var(--text);line-height:1.7">';
  body+='解析文件：<b>'+esc(R.filename)+'</b><br>';
  body+='共解析 <b>'+R.totalOrders+'</b> 张订单、<b>'+R.list.reduce(function(s,o){return s+o.items.length;},0)+'</b> 行明细。';
  if(R.noOrderId)body+='（另有 <b>'+R.noOrderId+'</b> 行缺少单据编号，已忽略）';
  body+='</div>';
  if(R.blocked){
    body+='<div style="margin:10px 0;padding:10px 12px;border-radius:8px;background:#fff3f3;color:#b00;border:1px solid #f3c2c2;font-size:13px">';
    if(R.dateMissing.length>0)body+='⛔ 存在 <b>'+R.dateMissing.length+'</b> 张订单缺少必填日期（单据日期 / 预计交货日期），无法导入。<br>';
    if(R.issuesCount>R.threshold)body+='⛔ 问题数量（<b>'+R.issuesCount+'</b>）超过上限（<b>'+R.threshold+'</b>），请先在 Excel 中修正后再导入。<br>';
    body+='请补全后重新导入本文件。</div>';
  }else{
    body+='<div style="margin:10px 0;padding:8px 12px;border-radius:8px;background:#f3fbf3;color:#1a7a1a;border:1px solid #c8e6c8;font-size:13px">各项问题可在下方批量处理，确认后即可导入。</div>';
  }
  function sec(title,count,inner){
    if(count===0)return '';
    return '<div style="margin-top:12px"><div style="font-weight:600;font-size:13px;margin-bottom:6px">'+title+'（'+count+'）</div>'+inner+'</div>';
  }
  if(R.emptyText.length){
    body+=sec('合同号 / 客户 为空',R.emptyText.length,
      '<div style="font-size:12px;color:#666">以下订单合同号或客户为空，将默认填入占位符「空」后导入：'+R.emptyText.map(function(o){return esc(o.id);}).join('、')+'</div>');
  }
  if(R.unknown.length){
    var rows=R.unknown.map(function(u){
      var it=u.o.items[u.li]||{};
      var desc=String(it.desc==null?'':it.desc).trim();
      var notes=String(it.lineNotes==null?'':it.lineNotes).trim();
      var mainParts=['单 '+u.o.id,'客户 '+String(u.o.customer==null?'':u.o.customer),'编码 '+u.pid];
      if(it.productName)mainParts.push('名称 '+it.productName);
      if(it.model)mainParts.push('型号 '+it.model);
      if(it.spec)mainParts.push('规格 '+it.spec);
      var main=mainParts.join(' · ');
      var subParts=[];
      if(desc)subParts.push('描述 '+desc);
      if(notes)subParts.push('行备注 '+notes);
      var subHtml='';
      if(subParts.length)subHtml='<div style="font-size:12px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px" title="'+esc(subParts.join(' · '))+'">'+esc(subParts.join(' · '))+'</div>';
      return '<div style="margin:5px 0;padding:6px 8px;border:1px solid #eee;border-radius:6px;background:#fafafa">'+
        '<div style="display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text)">'+
        '<div style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+esc(main)+'">'+esc(main)+'</div>'+
        '<div id="kd_unk_dec_'+u.idx+'" style="flex-shrink:0;white-space:nowrap"></div></div>'+subHtml+'</div>';
    }).join('');
    body+=sec('未知产品编码',R.unknown.length,
      '<div style="font-size:12px;color:#666;margin-bottom:6px">每行需完成决策：「选已有产品」（弹出产品选择器，含编码/名称/型号/规格）/「新建」/「忽视」；<b>未决策行无法导入</b>。</div>'+
      '<button class="btn btn-sm" onclick="kdBatchUnknown(\'__NEW__\')">全部新建</button>'+rows);
  }
  if(R.conflict.length){
    var rows2=R.conflict.map(function(c){
      var ex=orders.find(function(x){return x.id===c.id;});
      var warn=(ex&&orderTypeOf(ex)!=='销售订单')?' <span style="color:#b00;font-size:11px">（将改为销售订单）</span>':'';
      return '<div style="display:flex;gap:8px;align-items:center;margin:4px 0;font-size:12px"><span style="min-width:160px;color:var(--text)">'+esc(c.id)+warn+'</span>'+
        '<select id="kd_conflict_'+c.idx+'" onchange="kdState.conflict['+c.idx+']=this.value" style="flex:1">'+
        '<option value="overwrite">覆盖（整单替换）</option>'+
        '<option value="skip">跳过此单</option>'+
        '<option value="rename">变更订单号（自动加后缀）</option></select></div>';
    }).join('');
    body+=sec('订单号冲突（已存在）',R.conflict.length,
      '<div style="font-size:12px;color:#666;margin-bottom:6px">冲突订单默认「覆盖」整单；也可选择跳过或自动改名。</div>'+
      '<button class="btn btn-sm" onclick="kdBatchConflict(\'overwrite\')">全部覆盖</button>'+
      '<button class="btn btn-sm" onclick="kdBatchConflict(\'skip\')">全部跳过</button>'+
      '<button class="btn btn-sm" onclick="kdBatchConflict(\'rename\')">全部改名</button>'+rows2);
  }
  if(R.lineSkip.length){
    body+=sec('明细行跳过（商品编码为空）',R.lineSkip.length,
      '<div style="font-size:12px;color:#666">以下明细行因缺少商品编码将被跳过（不导入）：'+R.lineSkip.map(function(u){return esc(u.o.id+'#'+u.li);}).join('、')+'</div>');
  }
  body+='<div style="margin-top:10px;font-size:12px;color:#666">提示：数量 / 已交付数量 为空时按 <b>0</b> 导入；金额、单价、税额等字段不导入。</div>';
  var foot='<button class="btn" onclick="closeModal()">取消</button>'+
    (R.blocked?'<button class="btn btn-primary" disabled style="opacity:.5;cursor:not-allowed">问题过多，无法导入</button>':
      '<button class="btn btn-primary" onclick="kdDoImport()">确认导入（'+R.totalOrders+' 单）</button>');
  showModal('金蝶订单导入 · 预检报告',body,foot);
  if(R.unknown.length)R.unknown.forEach(function(u){kdRenderUnknownDec(u.idx);});
}

function kdBatchUnknown(v){
  if(!kdState||!kdReport)return;
  kdReport.unknown.forEach(function(u){kdSetUnknown(u.idx,v);});
}
/* 未知编码行决策位 HTML（4 态）：
   未决策：灰字「未决策」+ [选已有产品][新建][忽视]（默认不导入，须先决策）
   新建 __NEW__：黄底提示「将新建商品」+ [改选已有产品]
   替换 pid：绿底提示「替换为 编码+名称（型号/规格）」+ [改选][恢复新建]
   忽视 __SKIP__：红底提示「已忽视，此明细不导入」+ [恢复]（回到未决策） */
function kdUnknownDecHtml(idx){
  var v=kdState.unknown[idx];
  if(v==='__NEW__'){
    return '<span style="display:inline-block;padding:1px 6px;border-radius:4px;background:#fdf6e3;color:#8a6d00;border:1px solid #e8d9a0;font-size:12px">→ 将新建商品（库存/产能为 0）</span> '+
      '<button class="btn btn-sm" onclick="kdPickUnknown('+idx+')" style="margin-left:4px">改选已有产品</button>'+
      '<button class="btn btn-sm" onclick="kdSetUnknown('+idx+',\'__SKIP__\')" style="margin-left:4px">忽视</button>';
  }
  if(v==='__SKIP__'){
    return '<span style="display:inline-block;padding:1px 6px;border-radius:4px;background:#fdecea;color:#c0392b;border:1px solid #f0c4c0;font-size:12px">→ 已忽视，此明细不导入</span> '+
      '<button class="btn btn-sm" onclick="kdSetUnknown('+idx+',null)" style="margin-left:4px">恢复</button>';
  }
  var pid=v||null;
  if(pid){
    var p=products.find(function(x){return x.id===pid;});
    var label=pid+(p?(p.name?' '+p.name:''):'');
    if(p){
      var specs=[];
      if(p.model)specs.push('型号 '+p.model);
      if(p.spec)specs.push('规格 '+p.spec);
      if(specs.length)label+='（'+specs.join(' / ')+'）';
    }
    return '<span style="display:inline-block;padding:1px 6px;border-radius:4px;background:#f3fbf3;color:#1a7a1a;border:1px solid #c8e6c8;font-size:12px">→ 替换为 '+esc(label)+'</span> '+
      '<button class="btn btn-sm" onclick="kdPickUnknown('+idx+')" style="margin-left:4px">改选</button>'+
      '<button class="btn btn-sm" onclick="kdSetUnknown('+idx+',\'__NEW__\')" style="margin-left:4px">恢复新建</button>'+
      '<button class="btn btn-sm" onclick="kdSetUnknown('+idx+',\'__SKIP__\')" style="margin-left:4px">忽视</button>';
  }
  return '<span style="font-size:12px;color:#999;margin-right:4px">未决策</span>'+
    '<button class="btn btn-sm" onclick="kdPickUnknown('+idx+')" style="margin-right:4px">选已有产品</button>'+
    '<button class="btn btn-sm" onclick="kdSetUnknown('+idx+',\'__NEW__\')" style="margin-right:4px">新建</button>'+
    '<button class="btn btn-sm" onclick="kdSetUnknown('+idx+',\'__SKIP__\')">忽视</button>';
}
/* 局部刷新单个未知行的决策位（不重渲染整个报告，避免行多时弹窗滚动跳动） */
function kdRenderUnknownDec(idx){
  var el=document.getElementById('kd_unk_dec_'+idx);
  if(el)el.innerHTML=kdUnknownDecHtml(idx);
}
/* 弹出产品选择器（单选）：复用订单明细行的 productPickerModal，展示系统 编码/名称/型号/规格 等 */
function kdPickUnknown(idx){
  if(!kdState||!kdReport)return;
  var cur=kdState.unknown[idx];
  productPickerModal({
    mode:'single',
    preselected:(cur&&cur!=='__NEW__'&&cur!=='__SKIP__')?[cur]:[],
    onConfirm:function(ids){
      if(!ids.length)return;
      kdState.unknown[idx]=ids[0];
      kdRenderUnknownDec(idx);
    }
  });
}
function kdSetUnknown(idx,v){
  if(!kdState)return;
  kdState.unknown[idx]=v;
  kdRenderUnknownDec(idx);
}
function kdBatchConflict(v){
  if(!kdState||!kdReport)return;
  kdReport.conflict.forEach(function(c){kdState.conflict[c.idx]=v;});
  kdReport.conflict.forEach(function(c){var el=document.getElementById('kd_conflict_'+c.idx);if(el)el.value=v;});
}

function kdDoImport(){
  var R=kdReport;if(!R||!kdState)return;
  /* 校验：所有未知产品编码行必须已决策（替换/新建/忽视三选一），未决策默认不导入 */
  var undecided=R.unknown.filter(function(u){var v=kdState.unknown[u.idx];return v==null||v==='';});
  if(undecided.length){
    alert('还有 '+undecided.length+' 条未知产品编码未决策（未决策默认不导入）。\n请为每行选择「选已有产品 / 新建 / 忽视」后再确认导入。');
    var firstEl=document.getElementById('kd_unk_dec_'+undecided[0].idx);
    if(firstEl){
      firstEl.scrollIntoView({behavior:'smooth',block:'center'});
      firstEl.style.outline='2px solid #e74c3c';firstEl.style.outlineOffset='2px';
      setTimeout(function(){firstEl.style.outline='';firstEl.style.outlineOffset='';},2500);
    }
    return;
  }
  var pm=R.pm;
  var unkMap={};R.unknown.forEach(function(u){unkMap[u.o.id+'#'+u.li]=u.idx;});
  var confByOrderId={};R.conflict.forEach(function(c){confByOrderId[c.id]=c.idx;});
  var newOrders=[],newProducts=[],skipCount=0,overwriteLog=[],blockedCancel=[],totalLines=0,ignoredLines=0;
  R.list.forEach(function(o){
    if(!o.startDate||!o.deadline)return; // 日期缺失（理论上已被 blocked 拦截）
    var ci=confByOrderId[o.id];
    var decision=ci!=null?(kdState.conflict[ci]||'overwrite'):'overwrite';
    if(decision==='skip'){skipCount++;return;}
    var finalId=o.id;
    if(decision==='rename')finalId=kdRenameId(o.id);
    var items=[];
    o.items.forEach(function(it,li){
      var pid=String(it.productId==null?'':it.productId).trim();
      if(!pid)return; // 跳过商品编码空行
      var ui=unkMap[o.id+'#'+li];
      var u=(ui!=null)?kdState.unknown[ui]:null;
      if(u==='__SKIP__'){ignoredLines++;return;} // 忽视：此明细不导入
      if(u&&u!=='__NEW__')pid=u;
      else if(!pm[pid]){
        var np={id:pid,name:String(it.productName||pid),spec:String(it.spec||''),model:String(it.model||''),unit:String(it.unit||''),stock:0,dailyCap:0,stockMin:0,status:'启用'};
        newProducts.push(np);pm[pid]=np;
      }
      /* 落库时回填产品名称/规格/型号（以产品主数据为准，非 Excel 原值） */
      var pp=pm[pid]||{};
      var _impQty=num(it.orderQty)||0,_impDq=num(it.deliveredQty)||0;
      /* .108：金蝶导入的已交付无调用支撑（calledQty 恒无），deliveredQty>0 即视为期初直接交付基数 directDelivered——
         避免 .100 行级上限把全部已交付当作已消耗调用额度、导致后续交付被拦（防新导入数据再入坑） */
      var _impItem={productId:pid,productName:pp.name||'',spec:pp.spec||'',model:pp.model||'',orderQty:_impQty,deliveredQty:_impDq,lineNotes:String(it.lineNotes||''),stockMax:'',stockMin:''};
      if(_impDq>0&&!(num(it.calledQty)>0))_impItem.directDelivered=_impDq;
      items.push(_impItem);
    });
    if(items.length===0){skipCount++;return;}
    totalLines+=items.length;
    var no={orderType:'销售订单',status:'执行中',src:'kingdee',srcFile:R.filename,id:finalId,customer:String(o.customer||'空'),startDate:o.startDate,deadline:o.deadline,contractNo:String(o.contractNo||'空'),items:items};
    if(decision==='overwrite'){
      var exIdx=orders.findIndex(function(x){return x.id===o.id;});
      if(exIdx>=0){
        var _ex=orders[exIdx];
        /* 2026-08-25.3：已取消/已暂停订单禁止被导入覆盖（避免绕过状态机恢复已终止订单） */
        if(_ex.status==='已取消'||_ex.status==='已暂停'){blockedCancel.push(o.id);skipCount++;return;}
        overwriteLog.push(o.id);orders.splice(exIdx,1);
      }
    }
    newOrders.push(no);
  });
  orders.push.apply(orders,newOrders);
  if(newProducts.length){products.push.apply(products,newProducts);save('products',products);}
  save('orders',orders);
  syncOrderAutoStatus();   // 2026-08-25.3：导入后按未交付合计自动判定状态（Excel 已交付全量→已完成）
  var detail='从金蝶导入 '+newOrders.length+' 单 / '+totalLines+' 行';
  if(overwriteLog.length)detail+='（覆盖 '+overwriteLog.length+' 单）';
  if(ignoredLines)detail+='，忽视 '+ignoredLines+' 行';
  if(newProducts.length)detail+='，新建产品 '+newProducts.length+' 个（库存/产能为0，请补全）';
  if(blockedCancel.length)detail+='，跳过已取消/已暂停不可覆盖 '+blockedCancel.length+' 单';
  if(skipCount)detail+='，跳过 '+skipCount+' 单';
  logOp('导入','订单管理',detail+'（来源文件：'+R.filename+'）');
  closeModal();renderContent();
  clearSel('order_frame');   /* 2026-08-25.5：导入覆盖会 splice 旧订单导致索引漂移，清理销售订单区块勾选防幽灵选择 */
  alert('导入完成：'+detail+'\n\n销售订单已生成，审核状态默认「执行中」。');
  kdReport=null;kdState=null;
}
