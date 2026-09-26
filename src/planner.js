'use strict';

const { trace } = require('./trace');

/**
 * 清洗规划（只读试算，不写入也不修改任何原始记录）
 *
 * 用户指定一种过敏原、一个或多个目标批次，以及至多 10 个候选清洗位置
 * （设备 + 时间）。每个候选位置被视作一次“仅移除所选过敏原”的临时清洗，
 * 与现有批次 / 清洗记录合并后复用推演引擎 trace() 重新推演，搜索候选位置
 * 的子集，使所有目标批次的最终过敏原集合均不含该过敏原。
 *
 * 最优准则：
 *   1. 新增清洗次数最少；
 *   2. 次数相同时，按候选输入序号（0 基）列表的字典序取第一个可行子集，
 *      例如 [0,2] 字典序先于 [0,3] 与 [1,2]。
 *
 * 无解情形：
 *   - 目标批次的配方自带该过敏原：配方源头始终成立，清洗无法消除；
 *   - 候选位置的任意子集都无法使全部目标批次最终不含该过敏原。
 * 无需新增清洗（所有目标批次当前已不含该过敏原）时返回空方案。
 */

/**
 * @param {{equipment: Array, batches: Array, cleanings: Array}} data 原始记录（只读）
 * @param {{allergen: string, batchIds: string[], candidates: Array<{equipmentId: string, time: string}>}} input
 * @returns {object} 规划结果
 */
function planCleaning(data, input) {
  const { allergen, batchIds, candidates } = input;

  const baseline = trace(data);
  const batchById = new Map((data.batches || []).map((b) => [b.id, b]));
  const eqName = new Map((data.equipment || []).map((eq) => [eq.id, eq.name]));

  const echoCandidates = () =>
    candidates.map((c, i) => ({
      index: i,
      equipmentId: c.equipmentId,
      equipmentName: eqName.get(c.equipmentId) || c.equipmentId,
      time: c.time,
    }));

  const resultMap = (tr) => new Map(tr.batches.map((b) => [b.batchId, b]));

  const viewTarget = (tr, batchId) => {
    const b = batchById.get(batchId);
    const r = resultMap(tr).get(batchId);
    const finalAllergens = r ? r.finalAllergens : [];
    return {
      batchId,
      name: b.name,
      time: b.time,
      recipeAllergens: r ? r.recipeAllergens : (b.allergens || []),
      finalAllergens,
      hasAllergen: finalAllergens.includes(allergen),
    };
  };

  // 规划前：基于原始记录推演
  const beforeViews = batchIds.map((id) => viewTarget(baseline, id));

  const buildTargets = (afterTrace) =>
    beforeViews.map((bv) => {
      const after = afterTrace ? viewTarget(afterTrace, bv.batchId) : bv;
      return {
        batchId: bv.batchId,
        name: bv.name,
        time: bv.time,
        recipeAllergens: bv.recipeAllergens,
        before: bv.finalAllergens,
        after: after.finalAllergens,
        recipeBlocked: bv.recipeAllergens.includes(allergen),
        containsBefore: bv.hasAllergen,
        containsAfter: after.hasAllergen,
      };
    });

  const base = {
    allergen,
    candidates: echoCandidates(),
    cleaningCount: 0,
    positions: [],
  };

  const batchLabel = (list) =>
    list.map((t) => `「${t.name}」`).join('、');

  // 1) 配方自带屏障：配方过敏原不可能被清洗消除
  const blocked = beforeViews.filter((v) =>
    v.recipeAllergens.includes(allergen)
  );
  if (blocked.length) {
    return {
      ...base,
      feasible: false,
      empty: false,
      reason: 'recipe-allergen',
      message:
        `${batchLabel(blocked)}的配方自带「${allergen}」，配方自带过敏原无法被清洗消除，` +
        '因此不存在可行规划（仅可考虑调整配方或改产线）。',
      targets: buildTargets(null),
    };
  }

  // 2) 已经全部达标：空方案
  if (!beforeViews.some((v) => v.hasAllergen)) {
    return {
      ...base,
      feasible: true,
      empty: true,
      reason: null,
      message: `所有目标批次当前均不含「${allergen}」，无需新增清洗，空方案即可。`,
      targets: buildTargets(null),
    };
  }

  // 3) 子集搜索：按子集大小升序，同大小按序号列表字典序枚举
  const simulate = (subset) =>
    trace({
      equipment: data.equipment,
      batches: data.batches,
      cleanings: [
        ...data.cleanings,
        ...subset.map((idx) => ({
          // 合成 id 仅参与同刻事件的稳定排序，不影响存储
          id: `__plan_pos_${String(idx).padStart(2, '0')}`,
          equipmentId: candidates[idx].equipmentId,
          time: candidates[idx].time,
          allergens: [allergen],
          note: '',
        })),
      ],
    });

  const allClear = (tr) => {
    const m = resultMap(tr);
    return batchIds.every((id) => {
      const r = m.get(id);
      return !r || !r.finalAllergens.includes(allergen);
    });
  };

  for (let k = 1; k <= candidates.length; k++) {
    for (const combo of combinations(candidates.length, k)) {
      const planned = simulate(combo);
      if (allClear(planned)) {
        const echoed = echoCandidates();
        return {
          ...base,
          feasible: true,
          empty: false,
          reason: null,
          cleaningCount: combo.length,
          positions: combo.map((idx) => echoed[idx]),
          message:
            `最优方案：在 ${combo.length} 个候选位置新增清洗（均只移除「${allergen}」），` +
            '即可让全部目标批次最终不含该过敏原。',
          targets: buildTargets(planned),
        };
      }
    }
  }

  // 4) 任意子集都无法达标
  const message = candidates.length
    ? `给出的 ${candidates.length} 个候选清洗位置的任意子集都无法让全部目标批次最终不含「${allergen}」，请补充更早或覆盖更多相关设备的候选位置。`
    : `未提供任何候选清洗位置，无法消除目标批次中的「${allergen}」。`;
  return {
    ...base,
    feasible: false,
    empty: false,
    reason: 'no-feasible-subset',
    message,
    targets: buildTargets(null),
  };
}

/**
 * 按字典序枚举 [0,n) 中取 k 个的所有组合。
 * 深度优先、序号递增生成，天然为字典序，如 n=3,k=2：
 * [0,1] → [0,2] → [1,2]。
 */
function* combinations(n, k) {
  const combo = [];
  const rec = function* (start) {
    if (combo.length === k) {
      yield combo.slice();
      return;
    }
    // 剩余槽位必须有足够元素可填
    for (let i = start; i <= n - (k - combo.length); i++) {
      combo.push(i);
      yield* rec(i + 1);
      combo.pop();
    }
  };
  yield* rec(0);
}

module.exports = { planCleaning };
