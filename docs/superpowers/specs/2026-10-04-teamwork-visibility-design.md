# Teamwork 分工可视化设计 (A 方案)

日期: 2026-10-04
状态: 已批准 (A: 侧栏修灯 + widgetsBelow 独立状态块 + 可见性保底)

## 1. 问题

- 右侧【teamwork】侧栏在用户环境根本不可见: `teamworkSideWidth` 90 列门限 +
  fullscreen `side` 槽 + 窄屏 fallback 只挂 inline `TeamworkPanel`, 易被 transcript 淹没。
- 既有指示是行首 `·` -> braille 旋转帧 (`SPIN_FRAMES`, 80ms) + accent 加粗,
  非呼吸灯语义, idle 无常驻灯。
- Footer (`footer.ts render`) 只读 `session.state.model` (已被 leader override),
  worker/reviewer 模型从不进入 footer。

## 2. 目标 (用户已确认)

- 侧栏: `●` + 旋转双指示, 行首替换。idle dim `●`, 工作时旋转帧 accent 加粗。
- 聊天框下方: 独立状态块 (`widgetsBelow`, editor 与 footer 之间), 仅显示当前
  工作者, 多 worker 并行时纵向多行。
- 每行格式: `【角色-分工】provider model thinkingLevel`, thinking off 显示 off。
  例: `【leader】kimi k3 xhigh`, `【worker1-UI designer】kimi k3 high`,
  `【worker2-engineer】DeepSeek v4.1-flash xhigh`, reviewer 同理
  `【reviewer】provider model thinking`。
- 非 teamwork / 无工作者 / `teamwork.completed+collapse` 后状态块隐藏,
  footer 恢复单模型。

## 3. 非目标

- 不改 footer 第二行右对齐单行逻辑 (方案 B 已否决)。
- 不改 90/120 列侧栏门限, 不改 `SerialExecutor` 串行语义。
- 不加 websocket/store 新通道。

## 4. 架构与数据流 (复用现有事件)

```
orchestrator member.started/review.started (带 provider/model/taskId)
-> tools/teamwork.ts emit onUpdate{details:{runId,phase,teamwork:event}}
-> interactive-mode.ts tool_execution_update/end: teamworkPanel.updateFromEvent()
-> 同一次调用内同时刷新: layoutTeamworkSide() + 新状态块 updateFromSnapshot()
```

- 成员状态唯一来源: `TeamworkPanelComponent.getSnapshot()` (`panel.ts` 归约)。
- 模型/档位来源: `settingsManager.getRoleModels()[role].{provider,model,thinkingLevel}`,
  leader-follow 时经 `resolveEffectiveLeader(roleModels, sessionModel)`。
- 分工名来源: `snapshot.members[].description` (`worker1` -> `UI designer`),
  经 `formatWorkerLabel(role, description)` 生成 `worker1-UI designer` 段。

## 5. 组件改动

### 5.1 `teamwork-sidebar.ts wrapRow` (修灯, 最小改动)

- idle 行首: `·` -> `theme.fg("dim", "●")` 常驻。
- active 行首: 现有 `SPIN_FRAMES[spinFrame]` accent bold 保留, 即工作时旋转。
- 折叠行 `…N more ●` 语义不变 (`hiddenActive` 已有)。
- `getSpinningRoles` / `syncSpinTimer(80ms)` 不变。

### 5.2 新增 `TeamworkStatusComponent` (widgetsBelow 独立块)

- 位置: `widgetContainerBelow` (`extensionWidgetsBelow`, key `teamwork-status`),
  dock 顺序 editor -> teamwork 状态块 -> footer, 不受 90 列门限限制。
- 纯函数: `formatTeamworkStatusLines(snapshot|undefined, roleModels, sessionModel): string[]`
  - 过滤 `status==="working" || status==="reviewing"` 成员。
  - leader 行: `【leader】{provider} {model} {thinking}`。
  - worker 行: `【{formatWorkerLabel(roleId,desc)}】{provider} {model} {thinking}`。
  - reviewer 行: `【reviewer】{provider} {model} {thinking}`。
  - 空 -> 返回 `[]`, 调用方隐藏组件。
- 渲染: 每行行首 `●` (working/reviewing: accent bold + 与侧栏同帧旋转或静态 accent;
  初版静态 accent bold 即可, 避免第二套 timer), 文字默认色, `thinking` 缺失按 `off`。
- 高度: 占用 `MAX_WIDGET_LINES(10)` 内, 预期 1-4 行; 超长截断 (worker>4 只显前 4 + `…N more`)。

### 5.3 `interactive-mode.ts` 接线

- `updateTeamworkModeUI()` / `tool_execution_update(teamwork)` /
  `tool_execution_end(teamwork)` / `agent_end` 四处已有 `layoutTeamworkSide()` 旁
  加 `updateTeamworkStatusBlock()` (读 snapshot + roleModels + sessionModel, set/隐藏)。
- `enter/exitTeamworkMode` 时创建/销毁, 退出隐藏 (footer 恢复单模型由现有
  `restoreTeamworkPreviousModel` 负责)。
- 首帧竞态: `activateTeamworkMode()` 内 `ensureTeamworkFullscreen()` 后补一次
  `layoutTeamworkSide()` (已部分存在, 确认全屏切换异步完成后重调一次)。

## 6. 错误处理

- snapshot undefined / roleModels 缺项: 状态块隐藏, 不抛错 (worker 未绑定走现有
  `ensureWorkerBindings` 弹窗流程)。
- provider/model 缺失: 显示 `—`, 不阻断。
- 窄屏 (<90 列): 侧栏仍隐藏 (符合现有设计), 状态块照常显示, 保证分工可见。

## 7. 测试

- `teamwork-sidebar` 单测: idle 行首 dim `●`, active 行首为 SPIN 帧其一 + accent。
- `formatTeamworkStatusLines` 单测四例:
  1. 单 leader working -> 1 行 `【leader】…`。
  2. 双 worker 并行 -> 纵向 2 行, 含分工名。
  3. reviewer reviewing -> 1 行 `【reviewer】…`。
  4. 空 snapshot / 全 completed -> `[]` (隐藏)。
- 窄屏用例: `columns=80` 时侧栏隐藏但状态块仍返回行。
- 改动后跑 `./test.sh` 相关包单测 (不跑全量 e2e)。

## 8. 自检 (spec self-review)

- 无 TBD/TODO 占位; 格式示例与用户原话一致 (provider/model/thinking 三段)。
- 与现有 `panel.ts` 事件协议 (`TeamworkEvent` 7 种全带 provider/model) 一致。
- 范围单计划可容: 1 修灯 + 1 新组件 + 1 接线, 无 unrelated 重构。
- 歧义已消: 多 worker 指并行 working 多行 (串行下通常 1 行); reviewer 显示确认含在内。
