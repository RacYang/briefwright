import { loadEffectiveConfig } from "../config/load.js";
import { MysqlControlPlane, PostgresControlPlane } from "../control-plane/sql.js";

export async function provisionSqlProject(configPath: string) {
  const config = await loadEffectiveConfig(configPath);
  if (config.controlPlane.driver !== "postgres" && config.controlPlane.driver !== "mysql") {
    throw new Error("sql provision requires a configured PostgreSQL or MySQL process store");
  }
  const store = config.controlPlane.driver === "postgres" ? new PostgresControlPlane(config) : new MysqlControlPlane(config);
  try {
    await store.ensureSchema();
    const checks = await store.doctor();
    return { driver: store.driver, checks, ready: checks.every((check) => check.ok) };
  } finally { await store.close(); }
}
