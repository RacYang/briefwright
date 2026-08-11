import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { PolicyDefinition } from "../config/types.js";
import { canonicalJson, loadEffectiveConfig, validatePolicy } from "../config/load.js";
import { prepareSafeFilePath } from "../config/paths.js";
import { writeArtifactSetAtomic } from "../outputs/write.js";
import { SqliteStateStore } from "../state/sqlite.js";

export async function createPolicyExperiment(configPath: string, candidatePath: string) {
  const config = await loadEffectiveConfig(configPath);
  const policy = JSON.parse(await readFile(path.resolve(candidatePath), "utf8")) as PolicyDefinition;
  validatePolicy(policy);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    return { experimentId: store.createExperiment(policy, config.policy) };
  } finally { store.close(); }
}

export async function evaluatePolicyExperiment(configPath: string, id: string) {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { return store.evaluateExperiment(id); } finally { store.close(); }
}

export async function transitionPolicyExperiment(configPath: string, id: string, action: "approve" | "activate" | "rollback") {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const target = path.join(config.projectRoot, ".briefwright/active-policy.json");
    if (action === "activate") {
      const experiment = store.experiment(id);
      const currentDigest = createHash("sha256").update(canonicalJson(config.policy)).digest("hex");
      if (currentDigest !== experiment.baselineDigest) throw new Error(`Experiment ${id} baseline no longer matches the active policy; recreate and re-evaluate it`);
      let transition!: ReturnType<SqliteStateStore["transitionExperiment"]>;
      await writeArtifactSetAtomic(config.projectRoot, [{ path: target, content: `${JSON.stringify(experiment.policy, null, 2)}\n` }], () => {
        transition = store.transitionExperiment(id, action);
      });
      return transition;
    } else if (action === "rollback") {
      const experiment = store.experiment(id);
      const currentDigest = createHash("sha256").update(canonicalJson(config.policy)).digest("hex");
      if (currentDigest !== experiment.candidateDigest) throw new Error(`Experiment ${id} is not the policy currently active on disk`);
      await prepareSafeFilePath(config.projectRoot, target);
      const backup = `${target}.rollback-${randomUUID()}`;
      await rename(target, backup);
      let transitioned = false;
      try {
        const transition = store.transitionExperiment(id, action);
        transitioned = true;
        await unlink(backup).catch(() => undefined);
        return transition;
      } catch (error) {
        if (!transitioned) await rename(backup, target);
        throw error;
      }
    }
    return store.transitionExperiment(id, action);
  } finally { store.close(); }
}
