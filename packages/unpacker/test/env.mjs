/**
 * 测试用配置 —— **唯一的一处**，且不含任何本机绝对路径。
 *
 * 原则：代码要能在别人的机器上跑。所以这里全部靠"环境变量 + 相对位置发现"，
 * 找不到就给出明确提示并**跳过**，而不是回退到某个开发者电脑上的路径 ——
 * 那种默认值最坏的地方是"看起来有值"，只是指向不存在的地方。
 *
 *   LPK_WORKSHOP      创意工坊包目录（形如 <steam>/steamapps/workshop/content/616720）
 *   LPK_SAMPLE_IDS    抽样包 id，逗号分隔（默认内置三个）
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 内置抽样包 id：这是**数据标识**不是本机路径，可以有默认值 */
export const sampleIds = (process.env.LPK_SAMPLE_IDS ?? '3140192145,3572004785,3299783566')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

/** 创意工坊目录；没配置或不存在就返回 null（调用方据此跳过需要真包的用例） */
export function workshopDir() {
  const value = process.env.LPK_WORKSHOP;
  if (!value) return null;
  return existsSync(value) ? value : null;
}

/** 某个包在工坊里的 .lpk 路径 */
export function workshopLpk(id) {
  const dir = workshopDir();
  if (!dir) return null;
  const file = join(dir, id, `${id}.lpk`);
  return existsSync(file) ? file : null;
}

/** 某个包在工坊里的 config.json（STM_1_0 包解密要用） */
export function workshopConfig(id) {
  const dir = workshopDir();
  if (!dir) return null;
  const file = join(dir, id, 'config.json');
  return existsSync(file) ? file : null;
}

/** 找不到工坊目录时打印"缺什么、怎么给"，返回 true 表示调用方应当跳过 */
export function skipWithoutWorkshop(label) {
  if (workshopDir()) return false;
  console.log(
    `  （跳过${label}：没有配置创意工坊目录。设置 LPK_WORKSHOP=<steam>/steamapps/workshop/content/616720 后重跑）`,
  );
  return true;
}
