#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""docs/ai/ 手册校验脚本（工具脚本，不属于业务代码）

用途
----
校验 docs/ai/ 下 6 份 AI 架构手册的结构完整性、跨文件一致性，以及依赖边的证据完备性。
非业务代码，不参与部署；仅在手改手册后运行，防止 YAML 语法错误或索引/边不自洽。

怎么跑
------
    python docs/ai/_tools/validate.py
（也可在 docs/ai/ 目录下直接 `python _tools/validate.py`）

退出码
------
    0 = 全部通过（可能有 warning）
    1 = 存在 error

校验内容
--------
  1. 6 份 YAML 均能被 yaml.safe_load 解析
  2. 结构完整性：必填字段存在
  3. 跨文件一致性：
     - dependency-map.edges 的 from/to 必须能在 nodes 中命中
     - reverse_index 的边 id 必须真实存在；且与 edges 的 from/to 双向自洽
     - 每条 edge 必须带 file:行号（证据）
     - invariants 被 edge.invariant_refs / domain-map 引用的 id 必须存在
     - domain-map.projections[].callers 的 file 锚点格式合法
     - flows 的 id 与 domain-map 命令的 see_also 引用一致
  4. 风险标注：gap 类不变量必须有 violation_consequence
"""
import os
import re
import sys

import yaml

DOCS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = {
    'domain': 'domain-map.yaml',
    'dep': 'dependency-map.yaml',
    'inv': 'invariants.yaml',
    'flows': 'flows.yaml',
    'log': 'change-log.yaml',
}


# 允许「未核实」占位的 file 值
UNVERIFIED_TOKENS = ('未核实',)

errors = []
warnings = []
info = []


def load(name):
    path = os.path.join(DOCS, FILES[name])
    with open(path, encoding='utf-8') as fh:
        data = yaml.safe_load(fh)
    return path, data


def check_anchor(value, where):
    """file 锚点校验。

    真实手册中 file 字段常写成「多锚点」形式，例如：
      'index.html:3494'
      'index.html:2262 / 3320'                      （同文件多行，简写）
      'server/server.js:16-26 / 159-167'
      'js/transfer.js:225, 292, 383, 595'
      'js/transfer.js:207 → 224'                    （调用链）
      'index.html:4791-4793 / 4291（注释）/ 4292'     （带说明）
      'index.html（stepsDefOf）'                     （未定位到行）
      '未核实' / 'none'
    因此校验规则为：整串必须「至少包含一个 file:line 锚点」
    且「不得出现明显非锚点的裸路径」（如仅 'index.html' 无行号）。
    """
    if value is None:
        return
    if value in UNVERIFIED_TOKENS or str(value).strip().lower() == 'none':
        warnings.append('%s: file 标注为「未核实/none」（可接受）' % where)
        return

    s = str(value)
    # 至少一个 file:line 锚点
    anchors = re.findall(r'[\w./\-]+\.(?:html|js|json):\d+(?:-\d+)?', s)
    if not anchors:
        # 允许「文件（说明）」形式，但必须标为未核实
        if re.match(r'^[\w./\-]+\.(?:html|js|json)\s*[（(].+[）)]$', s):
            warnings.append('%s: 仅给出文件与说明、未给出行号 -> %r（建议补行号或标未核实）'
                            % (where, s))
            return
        errors.append('%s: 未包含任何 file:line 锚点 -> %r' % (where, s))
        return

    # 整串中不得出现「无行号的裸相对路径」混在锚点里（说明性文字允许）
    stripped = re.sub(r'[\w./\-]+\.(?:html|js|json):\d+(?:-\d+)?', '', s)
    stripped = re.sub(r'[\s/,.、，+→()（）「」【】\-\u4e00-\u9fff：:;；]', '', stripped)
    if stripped:
        warnings.append('%s: file 字段含未识别的残留片段 -> %r' % (where, stripped))


# ---------------------------------------------------------------- 1. 解析
loaded = {}
for name in FILES:
    try:
        path, data = load(name)
        loaded[name] = data
        info.append('PARSE OK  %-22s  (%d bytes)' % (FILES[name], os.path.getsize(path)))
    except Exception as exc:  # noqa: BLE001
        errors.append('PARSE FAIL %s -> %s' % (FILES[name], exc))

if errors:
    print('\n'.join(info))
    print('\n'.join('ERROR   ' + e for e in errors))
    sys.exit(1)

# ------------------------------------------------- 2. domain-map 结构
dm = loaded['domain']
for key in ('version', 'updated', 'domains', 'entities', 'projections', 'commands'):
    if key not in dm:
        errors.append('domain-map: 缺少顶层字段 %r' % key)

dom_ids = set()
for d in dm.get('domains', []):
    dom_ids.add(d['id'])
    for req in ('name', 'storage_keys', 'entities'):
        if req not in d:
            errors.append('domain-map.domains[%s]: 缺少 %r' % (d['id'], req))

ent_ids = set()
for e in dm.get('entities', []):
    ent_ids.add(e['id'])
    for req in ('name', 'kind', 'storage_key'):
        if req not in e:
            errors.append('domain-map.entities[%s]: 缺少 %r' % (e['id'], req))
    if e['kind'] not in ('fact', 'projection', 'appendonly'):
        errors.append('domain-map.entities[%s]: kind 非法 -> %r' % (e['id'], e['kind']))
    if 'registered' not in e:
        warnings.append('domain-map.entities[%s]: 缺少 registered（注册表登记信息）' % e['id'])

proj_ids = set()
for p in dm.get('projections', []):
    proj_ids.add(p['id'])
    for req in ('formula', 'recompute'):
        if req not in p:
            errors.append('domain-map.projections[%s]: 缺少 %r' % (p['id'], req))
    for c in p.get('callers', []) or []:
        check_anchor(c.get('file'), 'domain-map.projections[%s].callers' % p['id'])

cmd_ids = set()
for c in dm.get('commands', []):
    cmd_ids.add(c['id'])
    if 'status' not in c:
        warnings.append('domain-map.commands[%s]: 缺少 status（现状/目标）' % c['id'])
    if c.get('file'):
        check_anchor(c['file'], 'domain-map.commands[%s]' % c['id'])

info.append('domain-map: %d domains / %d entities / %d projections / %d commands'
            % (len(dom_ids), len(ent_ids), len(proj_ids), len(cmd_ids)))

# ------------------------------------------------- 3. dependency-map 结构
dep = loaded['dep']
node_ids = set()
for n in dep.get('nodes', []):
    node_ids.add(n['id'])
    if n.get('kind') == 'field' and 'of' not in n:
        errors.append('dependency-map.nodes[%s]: kind=field 但缺少 of' % n['id'])

edges = dep.get('edges', [])
edge_ids = set()
edge_pairs = {}
for e in edges:
    eid = e['id']
    if eid in edge_ids:
        errors.append('dependency-map: 边 id 重复 -> %s' % eid)
    edge_ids.add(eid)
    for req in ('from', 'to', 'kind', 'sync', 'risk', 'file'):
        if req not in e:
            errors.append('dependency-map.edges[%s]: 缺少 %r' % (eid, req))
    if e.get('kind') not in ('derives', 'writes', 'reads', 'guards', 'triggers'):
        errors.append('dependency-map.edges[%s]: kind 非法 -> %r' % (eid, e.get('kind')))
    if e.get('risk') not in ('high', 'medium', 'low'):
        errors.append('dependency-map.edges[%s]: risk 非法 -> %r' % (eid, e.get('risk')))
    check_anchor(e.get('file'), 'dependency-map.edges[%s]' % eid)
    # 节点存在性（允许未登记的 field 节点写法：of 引用已存在实体）
    for side in ('from', 'to'):
        v = e[side]
        if v not in node_ids:
            errors.append('dependency-map.edges[%s]: %s 引用了未登记节点 -> %s' % (eid, side, v))
    edge_pairs[eid] = (e['from'], e['to'])

info.append('dependency-map: %d nodes / %d edges' % (len(node_ids), len(edges)))

# ------------------------------------- 4. reverse_index 与 edges 互查
ri = dep.get('reverse_index', {})
if not ri:
    errors.append('dependency-map: 缺少 reverse_index（AI 反查入口）')
ri_edges = set()
for key, ids in ri.items():
    if key not in node_ids:
        errors.append('dependency-map.reverse_index[%s]: 不是已登记节点' % key)
    for eid in ids:
        if eid not in edge_ids:
            errors.append('dependency-map.reverse_index[%s]: 引用不存在的边 -> %s' % (key, eid))
        ri_edges.add(eid)

missing_rev = edge_ids - ri_edges
if missing_rev:
    errors.append('dependency-map: 以下边未进 reverse_index（AI 将无法反查到）-> %s'
                  % ', '.join(sorted(missing_rev)))

# reverse_index 的方向正确性：changed id 应等于 from/to，或其「同一存储位置」的别名。
# 别名来源：projections.products.stock ⇄ entities.products.stock（同一字段）；
#           projections.order.calledQty ⇄ entities.orders.items.calledQty（投影落在该字段上）
ALIAS = {
    'entities.products.stock': {'projections.products.stock'},
    'projections.products.stock': {'entities.products.stock'},
    'entities.orders.items.calledQty': {'projections.order.calledQty'},
    'projections.order.calledQty': {'entities.orders.items.calledQty'},
    # 父实体 ↔ 其字段：改字段需看实体级边
    'entities.orders': {'entities.orders.items.deliveredQty', 'entities.orders.items.calledQty',
                        'entities.orders.status', 'entities.orders.items.directDelivered',
                        'entities.orders.items.stockMax'},
    'entities.orders.items.deliveredQty': {'entities.orders'},
    'entities.orders.items.calledQty': {'entities.orders'},
    'entities.orders.status': {'entities.orders'},
    'entities.orders.items.directDelivered': {'entities.orders'},
    'entities.orders.items.stockMax': {'entities.orders', 'entities.orders.items.deliveredQty'},
    'entities.deliveries': {'entities.deliveries.items.orderLine'},
    'entities.deliveries.items.orderLine': {'entities.deliveries'},
    'entities.productionPlans': {'entities.productionPlans.items.doneQty',
                                 'entities.productionPlans.items.dlLine'},
    'entities.productionPlans.items.doneQty': {'entities.productionPlans'},
    'entities.productionPlans.items.dlLine': {'entities.productionPlans'},
    'entities.processTemplates': {'entities.fields'},
    'entities.fields': {'entities.processTemplates'},
    # 投影落到同名字段：改实体字段 ⇄ 改该投影
    'entities.orders.status': {'projections.orders.status'},
    'projections.orders.status': {'entities.orders.status'},
    'entities.productionPlans.items.dlLine': {'entities.deliveries.items.orderLine'},
    'entities.deliveries.items.orderLine': {'entities.productionPlans.items.dlLine'},
}


def related(key, node):
    """key 与边端点 node 是否可视为「同一改动面」"""
    if key == node:
        return True
    if node in ALIAS.get(key, ()):
        return True
    if key in ALIAS.get(node, ()):
        return True
    # 前缀关系：entities.orders 与 entities.orders.items.xxx
    if node.startswith(key + '.') or key.startswith(node + '.'):
        return True
    return False


for key, ids in ri.items():
    for eid in ids:
        frm, to = edge_pairs[eid]
        if not (related(key, frm) or related(key, to)):
            errors.append('dependency-map.reverse_index[%s]: 边 %s 的 from/to (%s→%s) 与该节点无关'
                          % (key, eid, frm, to))

info.append('reverse_index: %d keys covering %d/%d edges' % (len(ri), len(ri_edges), len(edge_ids)))

# 高风险链路
hrc = dep.get('high_risk_chains', [])
hrc_ids = [c['id'] for c in hrc]
for c in hrc:
    if 'write_set' not in c or not c['write_set']:
        errors.append('dependency-map.high_risk_chains[%s]: 缺少 write_set' % c['id'])
    for w in c.get('write_set', []):
        for req in ('order', 'target', 'file'):
            if req not in w:
                errors.append('dependency-map.high_risk_chains[%s].write_set: 缺少 %r' % (c['id'], req))
        check_anchor(w.get('file'), 'high_risk_chains[%s].write_set' % c['id'])
    if 'known_defects' not in c:
        warnings.append('high_risk_chains[%s]: 未标注 known_defects' % c['id'])
if len(hrc_ids) < 3:
    errors.append('dependency-map: 高风险链路应至少登记 3 条（transfer.apply / applyReport / kdDoImport），当前 %d 条' % len(hrc_ids))
info.append('high_risk_chains: %s' % ', '.join(hrc_ids))

# ------------------------------------------------- 5. invariants 一致性
inv = loaded['inv']
inv_ids = set()
for i in inv.get('invariants', []):
    inv_ids.add(i['id'])
    for req in ('name', 'rule', 'status'):
        if req not in i:
            errors.append('invariants[%s]: 缺少 %r' % (i['id'], req))
    if i['status'] not in ('enforced', 'partial', 'gap'):
        errors.append('invariants[%s]: status 非法 -> %r' % (i['id'], i['status']))
    if i['status'] in ('gap', 'partial') and 'violation_consequence' not in i:
        errors.append('invariants[%s]: status=%s 但缺少 violation_consequence' % (i['id'], i['status']))
    if i['status'] == 'enforced' and 'guaranteed_by' not in i:
        errors.append('invariants[%s]: status=enforced 但缺少 guaranteed_by' % i['id'])
    if i.get('file'):
        check_anchor(i['file'], 'invariants[%s]' % i['id'])
    for f in (i.get('file') if isinstance(i.get('file'), list) else []) or []:
        check_anchor(f, 'invariants[%s]' % i['id'])

# edges 中引用的 invariant_refs 必须存在
for e in edges:
    for ref in e.get('invariant_refs', []) or []:
        if ref not in inv_ids:
            errors.append('dependency-map.edges[%s]: invariant_refs 引用不存在的 %s' % (e['id'], ref))

# dependency-map 的 projection / entity 节点中形如 INV-xxx 的引用
for e in edges:
    if e.get('invariant_refs'):
        continue

gap_summary = inv.get('gap_summary', {})
for level, items in gap_summary.items():
    for it in items:
        if it['id'] not in inv_ids:
            errors.append('invariants.gap_summary[%s]: 引用不存在的 %s' % (level, it['id']))

info.append('invariants: %d 条 (enforced=%d / partial=%d / gap=%d)'
            % (len(inv_ids),
               sum(1 for i in inv['invariants'] if i['status'] == 'enforced'),
               sum(1 for i in inv['invariants'] if i['status'] == 'partial'),
               sum(1 for i in inv['invariants'] if i['status'] == 'gap')))

# ------------------------------------------------- 6. flows 一致性
fl = loaded['flows']
flow_ids = set()
for f in fl.get('flows', []):
    flow_ids.add(f['id'])
    for req in ('name', 'entry', 'file'):
        if req not in f:
            errors.append('flows[%s]: 缺少 %r' % (f['id'], req))
    check_anchor(f.get('file'), 'flows[%s]' % f['id'])
    for w in f.get('write_set', []) or []:
        for req in ('order', 'step'):
            if req not in w:
                errors.append('flows[%s].write_set: 缺少 %r' % (f['id'], req))
        if w.get('file'):
            check_anchor(w['file'], 'flows[%s].write_set' % f['id'])
    for c in f.get('callers', []) or []:
        check_anchor(c.get('file'), 'flows[%s].callers' % f['id'])
    if 'failure_behavior' not in f:
        warnings.append('flows[%s]: 未标注 failure_behavior' % f['id'])

REQUIRED_FLOWS = [
    'transfer.apply', 'productionReport.complete', 'productionReport.delete',
    'prodPlan.upsert', 'prodPlan.cancel', 'prodPlan.delete',
    'delivery.upsert', 'order.upsert', 'jindie.import', 'inventory.rebuild',
]
missing_flows = [x for x in REQUIRED_FLOWS if x not in flow_ids]
if missing_flows:
    errors.append('flows: 缺少必覆盖的流程 -> %s' % ', '.join(missing_flows))

# transfer 的 5 个入口
ta = next((f for f in fl['flows'] if f['id'] == 'transfer.apply'), None)
if ta:
    eps = {e['id'] for e in ta.get('entry_points', [])}
    for need in ('transfer.call', 'transfer.return', 'transfer.conv', 'transfer.move', 'transfer.reverse'):
        if need not in eps:
            errors.append('flows.transfer.apply.entry_points: 缺少 %s' % need)
    info.append('transfer.apply entry_points: %s' % ', '.join(sorted(eps)))

# domain-map 命令 see_also 指向 flows 存在性
for c in dm['commands']:
    sa = c.get('see_also')
    if sa and sa.startswith('flows.yaml#'):
        fid = sa.split('#', 1)[1]
        if fid not in flow_ids:
            errors.append('domain-map.commands[%s].see_also 指向不存在的流程 -> %s' % (c['id'], fid))

# flows 引用的 invariant id（形如 INV-xxx）
for f in fl['flows']:
    blob = yaml.safe_dump(f, allow_unicode=True)
    for ref in set(re.findall(r'\bINV-\d{3}\b', blob)):
        if ref not in inv_ids:
            errors.append('flows[%s]: 引用不存在的 %s' % (f['id'], ref))

info.append('flows: %d 条' % len(flow_ids))

# ------------------------------------------------- 7. change-log 校验
cl = loaded['log']
changes = cl.get('changes', [])
for c in changes:
    for req in ('date', 'type', 'summary', 'migration', 'rollback', 'author'):
        if req not in c:
            errors.append('change-log[%s/%s]: 缺少 %r' % (c.get('date'), c.get('type'), req))
    if c.get('type') not in ('structural', 'rule', 'data-migration'):
        errors.append('change-log[%s]: type 非法 -> %r' % (c.get('date'), c.get('type')))
    for ref in c.get('affected_ids', []) or []:
        if ref.startswith('INV-') and ref not in inv_ids:
            errors.append('change-log[%s]: affected_ids 引用不存在的 %s' % (c.get('date'), ref))
        elif ref.startswith('paths.') or ref.startswith('entities.') or ref.startswith('projections.'):
            if ref not in node_ids and ref not in ent_ids and ref not in proj_ids:
                warnings.append('change-log[%s]: affected_ids 的 %s 未在 domain/dependency-map 中登记'
                                % (c.get('date'), ref))

info.append('change-log: %d 条变更记录' % len(changes))

# ------------------------------------------------- 8. 未核实项统计
unverified = []
for name, key in (('domain', 'unverified'), ('dep', 'unverified'),
                  ('inv', 'unverified'), ('flows', 'unverified'), ('log', 'unverified')):
    for u in loaded[name].get(key, []) or []:
        unverified.append('%s:%s' % (FILES[name], u.get('id') or u.get('edge') or '?'))
info.append('显式标注「未核实」: %d 处' % len(unverified))

# ---------------------------------------------------------------- 输出
print('=' * 72)
print('docs/ai/ 手册校验报告')
print('=' * 72)
for line in info:
    print('  ' + line)
print('-' * 72)
if warnings:
    print('WARN (%d)：' % len(warnings))
    for w in warnings:
        print('  ! ' + w)
    print('-' * 72)
if errors:
    print('ERROR (%d)：' % len(errors))
    for e in errors:
        print('  X ' + e)
    print('=' * 72)
    print('结果：FAIL')
    sys.exit(1)

print('结果：PASS  —— 全部 YAML 可 safe_load；结构完整；跨文件引用自洽')
print('=' * 72)
